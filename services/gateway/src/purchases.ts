import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import {
  computeRequestDigest,
  executeRequestSchema,
  GATEWAY_CATALOG,
  GATEWAY_CREDIT_LABEL,
  isInferenceSku,
  quoteRequestSchema,
  skuInputSchemas,
  type GatewaySku,
  type QuoteView,
} from "@veilo/contracts/gateway";
import { deriveAta, validateExactPaymentTransaction, X402ClientError } from "@veilo/x402-client";
import type { AccountRow } from "./auth";
import type { GatewayContext } from "./context";
import { immediate } from "./db/database";
import { GatewayError } from "./errors";
import { provenanceOf } from "./inference";
import { appendCreditEvent } from "./ledger/credits";
import type { KeyedLock } from "./locks";
import { conservativeInputTokens } from "./provider/token-bound";
import { SellerHostService, type SpecialistQuoteTerms } from "./seller-host/service";
import { deliverDataset } from "./skus/datasets";
import { buildMessages, validateContentPackage } from "./skus/prompts";

interface QuoteRow {
  id: string;
  account_id: string;
  operation_id: string;
  seq: bigint;
  sku: GatewaySku;
  request_digest: string;
  input_json: string;
  amount: bigint;
  asset: string;
  network: string;
  pay_to: string;
  merchant_ata: string;
  fee_payer: string;
  facilitator_url: string;
  max_timeout_seconds: bigint;
  max_input_tokens: bigint | null;
  max_output_tokens: bigint | null;
  delivery: string;
  gateway_identity: string;
  origin: string;
  created_at: string;
  expires_at: string;
  superseded_by: string | null;
}

type PurchaseState = "pending_settlement" | "finalized" | "delivered" | "incomplete" | "paid_no_result" | "unpaid";

interface PurchaseRow {
  id: string;
  quote_id: string;
  account_id: string;
  operation_id: string;
  sku: GatewaySku;
  amount: bigint;
  state: PurchaseState;
  result_json: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

interface AttemptRow {
  id: string;
  purchase_id: string;
  message_hash: string;
  payer: string;
  payment_header: string;
  blockhash: string;
  last_valid_block_height: bigint;
  state: "claimed" | "settle_unknown" | "submitted" | "finalized" | "failed";
  tx_signature: string | null;
  failure: string | null;
}

interface PaymentEventRow {
  id: string;
  purchase_id: string;
  tx_signature: string;
  amount: bigint;
  finalized_slot: bigint;
  observed_at: string;
}

export interface HttpResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const PAYER_HISTORY_LIMIT = 25;

export class PurchaseService {
  readonly sellerHost: SellerHostService | undefined;

  constructor(
    private readonly ctx: GatewayContext,
    private readonly lock: KeyedLock,
  ) {
    this.sellerHost = ctx.settings.role === "seller-host" ? new SellerHostService(ctx) : undefined;
  }

  // ---- reads -------------------------------------------------------------------------

  private quote(id: string): QuoteRow | undefined {
    return this.ctx.db.prepare("SELECT * FROM quotes WHERE id = ?").get(id) as QuoteRow | undefined;
  }

  private latestQuote(accountId: string, operationId: string): QuoteRow | undefined {
    return this.ctx.db
      .prepare("SELECT * FROM quotes WHERE account_id = ? AND operation_id = ? ORDER BY seq DESC LIMIT 1")
      .get(accountId, operationId) as QuoteRow | undefined;
  }

  private purchaseByQuote(quoteId: string): PurchaseRow | undefined {
    return this.ctx.db.prepare("SELECT * FROM purchases WHERE quote_id = ?").get(quoteId) as PurchaseRow | undefined;
  }

  private purchase(id: string): PurchaseRow {
    return this.ctx.db.prepare("SELECT * FROM purchases WHERE id = ?").get(id) as PurchaseRow;
  }

  private liveAttempt(purchaseId: string): AttemptRow | undefined {
    return this.ctx.db
      .prepare("SELECT * FROM payment_attempts WHERE purchase_id = ? AND state <> 'failed'")
      .get(purchaseId) as AttemptRow | undefined;
  }

  private paymentEvent(purchaseId: string): PaymentEventRow | undefined {
    return this.ctx.db.prepare("SELECT * FROM payment_events WHERE purchase_id = ?").get(purchaseId) as
      | PaymentEventRow
      | undefined;
  }

  private ownedQuote(account: AccountRow, quoteId: string): QuoteRow {
    const quote = this.quote(quoteId);
    if (!quote || quote.account_id !== account.id) throw new GatewayError(404, "NOT_FOUND", "Quote not found");
    return quote;
  }

  private expired(quote: QuoteRow): boolean {
    return this.ctx.now().getTime() >= Date.parse(quote.expires_at);
  }

  private executeUrl(quote: QuoteRow): string {
    return `${quote.origin}/v1/purchases/${quote.id}/execute`;
  }

  // ---- quotes ------------------------------------------------------------------------

  private assertAcceptance(sku: GatewaySku): void {
    const a = this.ctx.acceptance;
    // A seller host has no fixed merchant: each quote carries the listing's verified recipient.
    if (!a.ready || !a.feePayer || (this.ctx.settings.role === "operator" && !a.merchantAta)) {
      throw new GatewayError(503, "SERVICE_NOT_ALLOWED", `x402 acceptance is disabled: ${a.reason ?? "not verified"}`);
    }
    if (isInferenceSku(sku) || GATEWAY_CATALOG[sku].kind === "specialist") {
      const r = this.ctx.inference.readiness("inference");
      if (!r.ready) throw new GatewayError(503, r.code, `Inference unavailable: ${r.reason}`);
    }
  }

  async createQuote(account: AccountRow, body: unknown): Promise<HttpResult> {
    const parsed = quoteRequestSchema.safeParse(body);
    if (!parsed.success) throw new GatewayError(400, "BAD_REQUEST", "Invalid quote request");
    const { operationId, sku, requestDigest } = parsed.data;
    const def = GATEWAY_CATALOG[sku];
    const specialist = def.kind === "specialist";
    if (this.ctx.settings.role === "seller-host" && !specialist) {
      throw new GatewayError(400, "SERVICE_NOT_ALLOWED", "This seller host sells only specialist-job");
    }
    if (this.ctx.settings.role === "operator" && specialist) {
      throw new GatewayError(400, "SERVICE_NOT_ALLOWED", "specialist-job has no fixed price and is sold only by a seller host");
    }
    if (!specialist && def.x402Amount === null) throw new GatewayError(400, "SERVICE_NOT_ALLOWED", "SKU is not sold through x402");
    const input = skuInputSchemas[sku].safeParse(parsed.data.input);
    if (!input.success) throw new GatewayError(400, "BAD_REQUEST", "Input does not match the SKU input schema");
    if (computeRequestDigest(sku, input.data) !== requestDigest) {
      throw new GatewayError(400, "BAD_REQUEST", "requestDigest does not match the supplied input");
    }

    const latest = this.latestQuote(account.id, operationId);
    if (latest) {
      if (latest.sku !== sku || latest.request_digest !== requestDigest) {
        throw new GatewayError(409, "IDEMPOTENCY_CONFLICT", "Operation already quoted with a different request");
      }
      const purchase = this.purchaseByQuote(latest.id);
      // Paid, pending or uncertain operations keep their quote; expiry never resets them.
      if (purchase && purchase.state !== "unpaid") return { status: 200, body: this.quoteView(latest) };
      if (!this.expired(latest)) return { status: 200, body: this.quoteView(latest) };
    }

    if (account.status !== "active") throw new GatewayError(403, "ACCOUNT_STOPPED", "Gateway account is stopped");
    this.assertAcceptance(sku);
    if (isInferenceSku(sku)) {
      const bound = conservativeInputTokens(buildMessages(sku, input.data as Record<string, unknown>));
      if (bound > (def.maxInputTokens ?? 0)) {
        throw new GatewayError(413, "INPUT_TOO_LONG", `Input exceeds the ${def.maxInputTokens} token bound for ${sku}`);
      }
    }
    let terms: SpecialistQuoteTerms | undefined;
    if (specialist) terms = await (this.sellerHost as SellerHostService).verifyJob(skuInputSchemas["specialist-job"].parse(input.data));

    const now = this.ctx.now();
    const id = `q_${randomUUID()}`;
    const a = this.ctx.acceptance;
    immediate(this.ctx.db, () => {
      const current = this.latestQuote(account.id, operationId);
      if (current?.id !== latest?.id) throw new GatewayError(409, "IDEMPOTENCY_CONFLICT", "Concurrent quote for this operation");
      if (current) {
        const purchase = this.purchaseByQuote(current.id);
        if (purchase && purchase.state !== "unpaid") {
          throw new GatewayError(409, "IDEMPOTENCY_CONFLICT", "Operation has a live or paid purchase");
        }
      }
      this.ctx.db
        .prepare(
          `INSERT INTO quotes (id, account_id, operation_id, seq, sku, request_digest, input_json, amount, asset, network, pay_to,
             merchant_ata, fee_payer, facilitator_url, max_timeout_seconds, max_input_tokens, max_output_tokens, delivery,
             gateway_identity, origin, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          account.id,
          operationId,
          current ? current.seq + 1n : 1n,
          sku,
          requestDigest,
          JSON.stringify(input.data),
          terms ? terms.amount : def.x402Amount,
          this.ctx.settings.mint,
          this.ctx.settings.network,
          terms ? terms.payTo : this.ctx.settings.merchantAddress,
          terms ? terms.merchantAta : a.merchantAta,
          a.feePayer,
          this.ctx.settings.facilitatorUrl,
          this.ctx.settings.maxTimeoutSeconds,
          terms ? terms.maxInputTokens : def.maxInputTokens,
          terms ? terms.maxOutputTokens : def.maxOutputTokens,
          def.delivery,
          this.ctx.settings.identity,
          this.ctx.settings.origin,
          now.toISOString(),
          (terms ? terms.expiresAt : new Date(now.getTime() + this.ctx.settings.quoteTtlSeconds * 1000)).toISOString(),
        );
      if (current) this.ctx.db.prepare("UPDATE quotes SET superseded_by = ? WHERE id = ?").run(id, current.id);
      if (terms) (this.sellerHost as SellerHostService).bindQuote(id, account.id, operationId, terms);
    });
    return { status: 201, body: this.quoteView(this.quote(id) as QuoteRow) };
  }

  private quoteView(q: QuoteRow): QuoteView {
    return {
      quoteId: q.id,
      operationId: q.operation_id,
      accountId: q.account_id,
      sku: q.sku,
      requestDigest: q.request_digest,
      paymentPath: "x402",
      charge: { amount: q.amount.toString(), unit: "usdc_base_units" },
      usageLimits: {
        maxInputTokens: q.max_input_tokens === null ? null : Number(q.max_input_tokens),
        maxOutputTokens: q.max_output_tokens === null ? null : Number(q.max_output_tokens),
      },
      recipient: {
        network: q.network,
        asset: q.asset,
        payTo: q.pay_to,
        merchantAta: q.merchant_ata,
        feePayer: q.fee_payer,
        facilitatorUrl: q.facilitator_url,
      },
      gateway: { identity: q.gateway_identity, origin: q.origin },
      executeUrl: this.executeUrl(q),
      delivery: q.delivery,
      createdAt: q.created_at,
      expiresAt: q.expires_at,
      purchaseState: this.purchaseByQuote(q.id)?.state ?? null,
    };
  }

  // ---- payment requirements ------------------------------------------------------------

  private requirements(q: QuoteRow, challenge: { blockhash: string; last_valid_block_height: bigint }): PaymentRequirements {
    return {
      scheme: "exact",
      network: q.network as PaymentRequirements["network"],
      asset: q.asset,
      amount: q.amount.toString(),
      payTo: q.pay_to,
      maxTimeoutSeconds: Number(q.max_timeout_seconds),
      extra: {
        feePayer: q.fee_payer,
        recentBlockhash: challenge.blockhash,
        lastValidBlockHeight: challenge.last_valid_block_height.toString(),
      },
    };
  }

  private paymentRequired(q: QuoteRow, requirements: PaymentRequirements): PaymentRequired {
    return {
      x402Version: 2,
      error: "Payment required",
      resource: {
        url: this.executeUrl(q),
        serviceName: q.gateway_identity,
        description: GATEWAY_CATALOG[q.sku].title,
        mimeType: "application/json",
        tags: [`veilo-sku:${q.sku}`],
      },
      accepts: [requirements],
    };
  }

  private async challenge(q: QuoteRow): Promise<HttpResult> {
    let latest: { blockhash: string; lastValidBlockHeight: bigint };
    try {
      latest = await this.ctx.chain.getLatestBlockhash();
    } catch {
      throw new GatewayError(503, "PROVIDER_UNAVAILABLE", "Chain RPC unavailable; no payment challenge issued");
    }
    this.ctx.db
      .prepare(
        "INSERT OR IGNORE INTO challenges (id, quote_id, blockhash, last_valid_block_height, issued_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(`chl_${randomUUID()}`, q.id, latest.blockhash, latest.lastValidBlockHeight, this.ctx.now().toISOString());
    const pr = this.paymentRequired(
      q,
      this.requirements(q, { blockhash: latest.blockhash, last_valid_block_height: latest.lastValidBlockHeight }),
    );
    return {
      status: 402,
      headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(pr) },
      body: { ...pr, quoteId: q.id },
    };
  }

  // ---- execute -------------------------------------------------------------------------

  async execute(account: AccountRow, quoteId: string, body: unknown, paymentHeader: string | undefined): Promise<HttpResult> {
    const quote = this.ownedQuote(account, quoteId);
    const parsed = executeRequestSchema.safeParse(body);
    if (!parsed.success) throw new GatewayError(400, "BAD_REQUEST", "Invalid execute request");
    if (parsed.data.operationId !== quote.operation_id || parsed.data.requestDigest !== quote.request_digest) {
      throw new GatewayError(409, "IDEMPOTENCY_CONFLICT", "Operation or request digest does not match this quote");
    }
    return this.lock.run(quote.id, () => this.#execute(quote, paymentHeader));
  }

  async #execute(quote: QuoteRow, paymentHeader: string | undefined): Promise<HttpResult> {
    // Durable lookup first: an existing paid, pending or uncertain purchase never gets a new challenge.
    const existing = this.purchaseByQuote(quote.id);
    if (existing && existing.state !== "unpaid") {
      await this.advance(existing.id, false);
      return this.purchaseResponse(quote);
    }
    if (quote.superseded_by !== null || this.expired(quote)) {
      throw new GatewayError(410, "QUOTE_EXPIRED", "Quote expired; request a new quote for this operation");
    }
    this.assertAcceptance(quote.sku);
    if (this.sellerHost) await this.sellerHost.assertPayable(quote.id);
    if (paymentHeader === undefined) return this.challenge(quote);

    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(paymentHeader);
    } catch {
      throw new GatewayError(400, "BAD_REQUEST", "PAYMENT-SIGNATURE header is not a valid x402 payload");
    }
    const { requirements, challenge } = this.matchAccepted(quote, payload);
    const transaction = payload.payload.transaction;
    if (typeof transaction !== "string") throw new GatewayError(400, "POLICY_DENIED", "Payment payload has no transaction");
    let validated: Awaited<ReturnType<typeof validateExactPaymentTransaction>>;
    try {
      validated = await validateExactPaymentTransaction(
        transaction,
        {
          network: quote.network,
          mint: quote.asset,
          amount: quote.amount,
          payTo: quote.pay_to,
          merchantAta: quote.merchant_ata,
          feePayers: [quote.fee_payer],
          recentBlockhash: challenge.blockhash,
          requirePayerSignature: true,
        },
        deriveAta,
      );
    } catch (error) {
      if (error instanceof X402ClientError) {
        throw new GatewayError(400, "POLICY_DENIED", `Payment transaction rejected: ${error.reason}`);
      }
      throw error;
    }

    const prior = this.ctx.db
      .prepare("SELECT a.*, p.quote_id FROM payment_attempts a JOIN purchases p ON p.id = a.purchase_id WHERE a.message_hash = ?")
      .get(validated.messageHash) as (AttemptRow & { quote_id: string }) | undefined;
    if (prior) {
      if (prior.quote_id !== quote.id) {
        throw new GatewayError(409, "IDEMPOTENCY_CONFLICT", "This payment is already bound to another purchase");
      }
      await this.advance(prior.purchase_id, false);
      return this.purchaseResponse(quote);
    }

    let verify: Awaited<ReturnType<GatewayContext["facilitator"]["verify"]>>;
    try {
      verify = await this.ctx.facilitator.verify(payload, requirements);
    } catch {
      throw new GatewayError(503, "PROVIDER_UNAVAILABLE", "Facilitator verification unavailable; payment not claimed");
    }
    if (!verify.isValid) {
      throw new GatewayError(400, "POLICY_DENIED", `Facilitator rejected the payment: ${verify.invalidReason ?? "invalid"}`);
    }

    const now = this.ctx.now().toISOString();
    const purchaseId = immediate(this.ctx.db, () => {
      if (this.ctx.db.prepare("SELECT 1 FROM payment_attempts WHERE message_hash = ?").get(validated.messageHash)) {
        throw new GatewayError(409, "IDEMPOTENCY_CONFLICT", "This payment is already claimed");
      }
      let purchase = this.purchaseByQuote(quote.id);
      if (purchase && purchase.state !== "unpaid") {
        throw new GatewayError(409, "IDEMPOTENCY_CONFLICT", "Purchase already has a payment");
      }
      if (!purchase) {
        const pid = `pur_${randomUUID()}`;
        this.ctx.db
          .prepare(
            "INSERT INTO purchases (id, quote_id, account_id, operation_id, sku, amount, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending_settlement', ?, ?)",
          )
          .run(pid, quote.id, quote.account_id, quote.operation_id, quote.sku, quote.amount, now, now);
        purchase = this.purchase(pid);
      } else {
        this.ctx.db
          .prepare("UPDATE purchases SET state = 'pending_settlement', error_code = NULL, updated_at = ? WHERE id = ?")
          .run(now, purchase.id);
      }
      this.ctx.db
        .prepare(
          `INSERT INTO payment_attempts (id, purchase_id, message_hash, payer, payment_header, blockhash, last_valid_block_height, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?)`,
        )
        .run(
          `att_${randomUUID()}`,
          purchase.id,
          validated.messageHash,
          validated.payer,
          paymentHeader,
          challenge.blockhash,
          challenge.last_valid_block_height,
          now,
          now,
        );
      return purchase.id;
    });
    this.ctx.hooks.afterClaim?.();

    const attempt = this.liveAttempt(purchaseId) as AttemptRow;
    try {
      const settle = await this.ctx.facilitator.settle(payload, requirements);
      if (settle.success && typeof settle.transaction === "string" && settle.transaction !== "") {
        this.updateAttempt(attempt.id, { state: "submitted", tx_signature: settle.transaction, settle_response_json: JSON.stringify(settle) });
      } else {
        this.updateAttempt(attempt.id, {
          state: "settle_unknown",
          settle_response_json: JSON.stringify(settle),
          failure: settle.errorReason ?? "settlement not confirmed",
        });
      }
    } catch (error) {
      // A lost or failed settle response is not proof the transfer did not land.
      this.updateAttempt(attempt.id, { state: "settle_unknown", failure: `settle call failed: ${(error as Error).name}` });
    }
    await this.advance(purchaseId, true);
    return this.purchaseResponse(quote);
  }

  private matchAccepted(
    quote: QuoteRow,
    payload: PaymentPayload,
  ): { requirements: PaymentRequirements; challenge: { blockhash: string; last_valid_block_height: bigint } } {
    if (payload.x402Version !== 2 || !payload.accepted) {
      throw new GatewayError(400, "POLICY_DENIED", "Only x402 v2 payloads are accepted");
    }
    if (payload.resource !== undefined && payload.resource.url !== this.executeUrl(quote)) {
      throw new GatewayError(400, "POLICY_DENIED", "Payment resource does not match this quote");
    }
    const blockhash = payload.accepted.extra?.recentBlockhash;
    const challenge =
      typeof blockhash === "string"
        ? (this.ctx.db
            .prepare("SELECT blockhash, last_valid_block_height FROM challenges WHERE quote_id = ? AND blockhash = ?")
            .get(quote.id, blockhash) as { blockhash: string; last_valid_block_height: bigint } | undefined)
        : undefined;
    if (!challenge) throw new GatewayError(400, "POLICY_DENIED", "Payment does not answer a challenge issued for this quote");
    const requirements = this.requirements(quote, challenge);
    if (!isDeepStrictEqual(payload.accepted, requirements)) {
      throw new GatewayError(400, "POLICY_DENIED", "Payment requirements do not match the immutable quote");
    }
    return { requirements, challenge };
  }

  private updateAttempt(
    id: string,
    fields: Partial<Pick<AttemptRow, "state" | "tx_signature" | "failure">> & { settle_response_json?: string },
  ): void {
    const sets: string[] = ["updated_at = ?"];
    const values: unknown[] = [this.ctx.now().toISOString()];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      values.push(v);
    }
    this.ctx.db.prepare(`UPDATE payment_attempts SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  }

  // ---- reconciliation ------------------------------------------------------------------

  /** Moves a purchase forward using chain state; never prepares or settles a new payment. */
  async advance(purchaseId: string, wait: boolean): Promise<void> {
    const deadline = this.ctx.now().getTime() + (wait ? this.ctx.settings.settlementWaitMs : 0);
    for (;;) {
      let p = this.purchase(purchaseId);
      if (p.state === "pending_settlement") {
        const attempt = this.liveAttempt(p.id);
        if (attempt) await this.reconcileAttempt(p, attempt);
        p = this.purchase(purchaseId);
      }
      if (p.state === "finalized") {
        this.ctx.hooks.afterPaymentFinalized?.();
        await this.fulfil(p);
        p = this.purchase(purchaseId);
      }
      if (p.state !== "pending_settlement" || this.ctx.now().getTime() >= deadline) return;
      await this.ctx.sleep(this.ctx.settings.settlementPollMs);
    }
  }

  private async reconcileAttempt(purchase: PurchaseRow, attempt: AttemptRow): Promise<void> {
    const chain = this.ctx.chain;
    try {
      if (attempt.state === "claimed" || attempt.state === "settle_unknown") {
        // The payer is a single-use wallet, so its history identifies the settlement.
        const signatures = await chain.getSignaturesForAddress(attempt.payer, PAYER_HISTORY_LIMIT);
        for (const sig of signatures) {
          const tx = await chain.getTransaction(sig, "confirmed");
          if (tx && tx.messageHash === attempt.message_hash) {
            this.updateAttempt(attempt.id, { state: "submitted", tx_signature: sig });
            attempt = { ...attempt, state: "submitted", tx_signature: sig };
            break;
          }
        }
        if (attempt.state !== "submitted") {
          await this.failIfExpired(purchase, attempt, "blockhash expired with no settlement for this payment");
          return;
        }
      }
      if (attempt.state === "submitted" && attempt.tx_signature) {
        const tx = await chain.getTransaction(attempt.tx_signature, "finalized");
        if (!tx) {
          const seen = await chain.getTransaction(attempt.tx_signature, "confirmed");
          if (!seen) await this.failIfExpired(purchase, attempt, "submitted transaction never landed before expiry");
          return;
        }
        if (tx.messageHash !== attempt.message_hash) {
          this.updateAttempt(attempt.id, { state: "settle_unknown", tx_signature: null, failure: "reported signature is not this payment" });
          return;
        }
        if (tx.err !== null) {
          this.failAttempt(purchase, attempt, "settlement transaction failed on chain");
          return;
        }
        this.finalizePayment(purchase, attempt, attempt.tx_signature, tx.slot);
      }
    } catch {
      // RPC unavailable: leave the claim in place and reconcile later.
    }
  }

  private async failIfExpired(purchase: PurchaseRow, attempt: AttemptRow, reason: string): Promise<void> {
    const height = await this.ctx.chain.getFinalizedBlockHeight();
    if (height <= attempt.last_valid_block_height) return;
    // Re-check payer history after expiry: a transaction that landed late is still found.
    const signatures = await this.ctx.chain.getSignaturesForAddress(attempt.payer, PAYER_HISTORY_LIMIT);
    for (const sig of signatures) {
      const tx = await this.ctx.chain.getTransaction(sig, "confirmed");
      if (tx && tx.messageHash === attempt.message_hash) {
        this.updateAttempt(attempt.id, { state: "submitted", tx_signature: sig });
        return;
      }
    }
    this.failAttempt(purchase, attempt, reason);
  }

  private failAttempt(purchase: PurchaseRow, attempt: AttemptRow, reason: string): void {
    const now = this.ctx.now().toISOString();
    immediate(this.ctx.db, () => {
      this.ctx.db.prepare("UPDATE payment_attempts SET state = 'failed', failure = ?, updated_at = ? WHERE id = ?").run(reason, now, attempt.id);
      this.ctx.db.prepare("UPDATE purchases SET state = 'unpaid', updated_at = ? WHERE id = ? AND state = 'pending_settlement'").run(now, purchase.id);
    });
  }

  private finalizePayment(purchase: PurchaseRow, attempt: AttemptRow, signature: string, slot: bigint): void {
    const now = this.ctx.now().toISOString();
    immediate(this.ctx.db, () => {
      if (this.paymentEvent(purchase.id)) return;
      this.ctx.db.prepare("UPDATE payment_attempts SET state = 'finalized', updated_at = ? WHERE id = ?").run(now, attempt.id);
      this.ctx.db
        .prepare(
          "INSERT INTO payment_events (id, purchase_id, attempt_id, tx_signature, amount, finalized_slot, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(`pev_${randomUUID()}`, purchase.id, attempt.id, signature, purchase.amount, slot, now);
      this.ctx.db.prepare("UPDATE purchases SET state = 'finalized', updated_at = ? WHERE id = ?").run(now, purchase.id);
    });
  }

  // ---- fulfilment ----------------------------------------------------------------------

  private complete(purchaseId: string, state: "delivered" | "incomplete" | "paid_no_result", result: unknown, errorCode: string | null): void {
    const now = this.ctx.now().toISOString();
    this.ctx.db
      .prepare(
        "UPDATE purchases SET state = ?, result_json = ?, error_code = ?, updated_at = ?, delivered_at = ? WHERE id = ? AND state = 'finalized'",
      )
      .run(state, JSON.stringify(result), errorCode, now, state === "paid_no_result" ? null : now, purchaseId);
  }

  /** Consumes the single payment event exactly once. */
  private async fulfil(p: PurchaseRow): Promise<void> {
    const event = this.paymentEvent(p.id);
    if (!event) return;
    const quote = this.quote(p.quote_id) as QuoteRow;
    const def = GATEWAY_CATALOG[p.sku];
    const input = JSON.parse(quote.input_json) as Record<string, unknown>;

    if (def.kind === "credit_pack") {
      const units = def.issuesUnits as bigint;
      immediate(this.ctx.db, () => {
        const current = this.purchase(p.id);
        if (current.state !== "finalized") return;
        let issuance = this.ctx.db.prepare("SELECT id FROM credit_issuances WHERE purchase_id = ?").get(p.id) as { id: string } | undefined;
        const now = this.ctx.now();
        if (!issuance) {
          issuance = { id: `iss_${randomUUID()}` };
          this.ctx.db
            .prepare(
              "INSERT INTO credit_issuances (id, account_id, purchase_id, payment_event_id, payment_signature, sku, units, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(issuance.id, p.account_id, p.id, event.id, event.tx_signature, p.sku, units, now.toISOString());
          appendCreditEvent(this.ctx.db, { accountId: p.account_id, kind: "issue", units, issuanceId: issuance.id, at: now });
        }
        this.complete(
          p.id,
          "delivered",
          { kind: "credit_pack", issuanceId: issuance.id, issuedUnits: units.toString(), unit: "gateway_microcredits", label: GATEWAY_CREDIT_LABEL },
          null,
        );
      });
      return;
    }

    if (def.kind === "specialist") {
      await (this.sellerHost as SellerHostService).fulfil(p, event.tx_signature, {
        complete: (state, result, errorCode) => this.complete(p.id, state, result, errorCode),
        waiting: (code) =>
          this.ctx.db
            .prepare("UPDATE purchases SET error_code = ?, updated_at = ? WHERE id = ? AND state = 'finalized'")
            .run(code, this.ctx.now().toISOString(), p.id),
      });
      return;
    }

    if (def.kind === "dataset") {
      this.complete(p.id, "delivered", { kind: "dataset", ...deliverDataset(def.dataset as "basic" | "expanded", String(input.query)) }, null);
      return;
    }

    if (!isInferenceSku(p.sku)) return;
    const outcome = await this.ctx.inference.run({
      sourceKind: "purchase",
      sourceId: p.id,
      purpose: "x402",
      role: "inference",
      messages: buildMessages(p.sku, input),
      maxInputTokens: def.maxInputTokens as number,
      maxOutputTokens: def.maxOutputTokens as number,
      jsonObject: p.sku === "content-package",
    });
    const inference = inferenceResult(outcome, p.sku, input);
    switch (outcome.status) {
      case "succeeded":
        this.complete(p.id, inference.valid ? "delivered" : "incomplete", inference.result, null);
        return;
      case "rejected":
        // No provider request was sent; the paid purchase waits for the provider to become ready.
        this.ctx.db.prepare("UPDATE purchases SET error_code = ?, updated_at = ? WHERE id = ?").run(outcome.code, this.ctx.now().toISOString(), p.id);
        return;
      case "failed":
      case "uncertain":
        this.complete(p.id, "paid_no_result", { kind: "inference", status: outcome.status, message: outcome.message }, "PAID_NO_RESULT");
        return;
    }
  }

  // ---- responses -----------------------------------------------------------------------

  purchaseResponse(quote: QuoteRow): HttpResult {
    const p = this.purchaseByQuote(quote.id);
    const event = p ? this.paymentEvent(p.id) : undefined;
    const attempt = p ? this.liveAttempt(p.id) : undefined;
    const headers: Record<string, string> = {};
    if (event) {
      headers["PAYMENT-RESPONSE"] = encodePaymentResponseHeader({
        success: true,
        transaction: event.tx_signature,
        network: quote.network as PaymentRequirements["network"],
        payer: attempt?.payer ?? "",
      });
    }
    const state = !p
      ? "unpaid"
      : p.state === "finalized"
        ? p.error_code
          ? "paid_awaiting_provider"
          : "paid_fulfilment_pending"
        : p.state;
    const body = {
      quoteId: quote.id,
      operationId: quote.operation_id,
      sku: quote.sku,
      paymentPath: "x402" as const,
      state,
      charge: { amount: quote.amount.toString(), unit: "usdc_base_units" },
      payment: event
        ? { txSignature: event.tx_signature, network: quote.network, amount: event.amount.toString(), finalizedSlot: event.finalized_slot.toString(), observedAt: event.observed_at }
        : attempt
          ? { txSignature: attempt.tx_signature, network: quote.network, state: attempt.state }
          : null,
      result: p?.result_json ? (JSON.parse(p.result_json) as unknown) : null,
      error:
        state === "pending_settlement"
          ? { code: "SETTLEMENT_UNCERTAIN", message: "Waiting for confirmation" }
          : state === "paid_no_result"
            ? { code: "PAID_NO_RESULT", message: "Paid; result unavailable" }
            : state === "paid_awaiting_provider"
              ? { code: p?.error_code ?? "PROVIDER_UNAVAILABLE", message: "Paid; waiting for the provider" }
              : null,
      prepaidCreditsDebited: "0",
    };
    const status = state === "pending_settlement" || state === "paid_fulfilment_pending" || state === "paid_awaiting_provider" ? 202 : 200;
    return { status, body, headers };
  }

  async result(account: AccountRow, quoteId: string): Promise<HttpResult> {
    const quote = this.ownedQuote(account, quoteId);
    return this.lock.run(quote.id, async () => {
      const p = this.purchaseByQuote(quote.id);
      if (p && p.state !== "unpaid") await this.advance(p.id, false);
      return this.purchaseResponse(quote);
    });
  }

  /** Startup: reconcile pending settlements and complete fulfilment of finalized payments. */
  async recover(): Promise<void> {
    const rows = this.ctx.db
      .prepare("SELECT id, quote_id FROM purchases WHERE state IN ('pending_settlement', 'finalized')")
      .all() as Array<{ id: string; quote_id: string }>;
    for (const r of rows) await this.lock.run(r.quote_id, () => this.advance(r.id, false));
  }
}

export function inferenceResult(
  outcome: Awaited<ReturnType<GatewayContext["inference"]["run"]>>,
  sku: GatewaySku,
  input: Record<string, unknown>,
): { valid: boolean; result: unknown } {
  if (outcome.status !== "succeeded") return { valid: false, result: null };
  const provenance = provenanceOf(outcome);
  if (sku === "content-package") {
    const v = validateContentPackage(outcome.text, input.channels as string[]);
    return v.valid
      ? { valid: true, result: { kind: "content_package", ...v.content, provenance } }
      : { valid: false, result: { kind: "content_package", status: "incomplete", issues: v.issues, raw: outcome.text, provenance } };
  }
  return { valid: true, result: { kind: "inference", sku, text: outcome.text, provenance } };
}

