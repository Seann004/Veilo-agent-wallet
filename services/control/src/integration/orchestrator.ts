import type { FundingBinding, FundingProvider, FundingResult } from "@veilo/contracts";
import { computeRequestDigest, isGatewaySku, type GatewaySku } from "@veilo/contracts/gateway";
import { immediate } from "@veilo/db";
import { big, num, type Ledger } from "../context";
import { ControlError } from "../errors";
import { acceptInbox, enqueueOutbox, markOutboxPublished, writeAudit } from "../ledger/events";
import { reservedNoteFor } from "../ledger/notes";
import {
  advanceAuthority,
  assertAuthorityCurrent,
  cancelUnreleased,
  getPurchaseRow,
  markRecoverable,
  markUncertain,
  recordFundingExpiredUnsettled,
  recordFundingFinalized,
  recordMerchantFinalized,
  recordUsageConsumed,
  recordUsagePreDispatchFailure,
  transition,
  type PurchaseRow,
} from "../ledger/purchases";
import { GatewayUnreachableError, type GatewayClient, type GatewayResponse } from "./gateway-client";
import { KeyedLock } from "./locks";
import type { PermitSigner } from "./permits";

export interface ExecutionRow {
  purchase_id: string;
  path: "x402" | "usage";
  funding_ref: string | null;
  merchant_payer: string | null;
  merchant_message_hash: string | null;
  funding_token_fees: bigint | null;
  sponsor_lamports_spent: bigint | null;
  usage_permit: string | null;
  usage_permit_nonce: string | null;
  usage_permit_expires_at_ms: bigint | null;
  usage_reservation_id: string | null;
  gateway_state: string | null;
  result_json: string | null;
  last_error_code: string | null;
  last_error: string | null;
}

interface QuoteRow {
  purchase_id: string;
  seq: bigint;
  quote_id: string;
  charge_usdc: bigint;
  quote_json: string;
  expires_at_ms: bigint;
}

interface ServiceRow {
  id: string;
  origin: string;
  gateway_identity: string | null;
  recipient: string | null;
  recipient_ata: string | null;
  network: string;
  mint: string;
  status: string;
}

export interface ExecutionView {
  path: "x402" | "usage" | null;
  gatewayState: string | null;
  fundingMode: FundingProvider["mode"];
  quotes: Array<{ quoteId: string; seq: number; charge: string; expiresAt: string }>;
  result: unknown;
  blocked: { code: string; message: string } | null;
}

export interface OrchestratorDeps {
  ledger: Ledger;
  gateway: GatewayClient | undefined;
  permits: PermitSigner | undefined;
  funding: FundingProvider;
}

/** Margin after permit expiry before an absent gateway reservation counts as proof of none. */
const PERMIT_PROOF_MARGIN_MS = 30_000;
const MAX_STEPS = 16;

const TERMINAL_FULFILMENT = new Set(["delivered", "paid_without_result", "abandoned"]);

/** The gateway's 402 body is the PAYMENT-REQUIRED object plus its quote ID. */
function withoutQuoteId(body: unknown): Record<string, unknown> {
  const copy = { ...(body as Record<string, unknown>) };
  delete copy.quoteId;
  return copy;
}

class Blocked extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Drives one authorized purchase across control, the wallet funding leg and the gateway.
 * Every step reads durable state first and resumes the same logical operation; an unknown
 * outcome is reconciled by querying the existing gateway/wallet operation, never by creating
 * another permit, quote-payment or withdrawal.
 */
export class PurchaseOrchestrator {
  readonly #lock = new KeyedLock();
  constructor(readonly deps: OrchestratorDeps) {}

  get ledger(): Ledger {
    return this.deps.ledger;
  }

  get configured(): boolean {
    return this.deps.gateway !== undefined;
  }

  execution(purchaseId: string): ExecutionRow | undefined {
    return this.ledger.db.prepare(`SELECT * FROM purchase_execution WHERE purchase_id = ?`).get(purchaseId) as ExecutionRow | undefined;
  }

  input(purchaseId: string): Record<string, unknown> | undefined {
    const raw = this.ledger.db.prepare(`SELECT input_json FROM purchase_input WHERE purchase_id = ?`).pluck().get(purchaseId) as string | undefined;
    return raw === undefined ? undefined : (JSON.parse(raw) as Record<string, unknown>);
  }

  /** Records the exact SKU input once; it must hash to the purchase's request digest. */
  storeInput(p: PurchaseRow, input: Record<string, unknown>): void {
    if (!isGatewaySku(p.sku) || computeRequestDigest(p.sku, input) !== p.request_digest) {
      throw new ControlError("IDEMPOTENCY_CONFLICT", "input does not match the purchase request digest");
    }
    immediate(this.ledger.db, () => {
      const existing = this.ledger.db.prepare(`SELECT input_json FROM purchase_input WHERE purchase_id = ?`).pluck().get(p.id);
      if (existing !== undefined) return;
      this.ledger.db
        .prepare(`INSERT INTO purchase_input (purchase_id, request_digest, input_json, created_at_ms) VALUES (?, ?, ?, ?)`)
        .run(p.id, p.request_digest, JSON.stringify(input), this.ledger.now());
    });
  }

  view(purchaseId: string): ExecutionView {
    const ex = this.execution(purchaseId);
    const quotes = this.ledger.db
      .prepare(`SELECT * FROM purchase_quote WHERE purchase_id = ? ORDER BY seq`)
      .all(purchaseId) as QuoteRow[];
    return {
      path: ex?.path ?? null,
      gatewayState: ex?.gateway_state ?? null,
      fundingMode: this.deps.funding.mode,
      quotes: quotes.map((q) => ({
        quoteId: q.quote_id,
        seq: num(q.seq),
        charge: big(q.charge_usdc).toString(),
        expiresAt: new Date(num(q.expires_at_ms)).toISOString(),
      })),
      result: ex?.result_json ? (JSON.parse(ex.result_json) as unknown) : null,
      blocked: ex?.last_error_code ? { code: ex.last_error_code, message: ex.last_error ?? "" } : null,
    };
  }

  /** Advances the purchase as far as current evidence allows; safe to call repeatedly. */
  async drive(purchaseId: string): Promise<{ purchase: PurchaseRow; execution: ExecutionView }> {
    return this.#lock.run(purchaseId, async () => {
      try {
        await this.#drive(purchaseId);
        this.#setError(purchaseId, null, null);
      } catch (error) {
        if (error instanceof Blocked) this.#setError(purchaseId, error.code, error.message);
        else if (error instanceof GatewayUnreachableError) this.#setError(purchaseId, "NOT_READY", error.message);
        else if (error instanceof ControlError) this.#setError(purchaseId, error.code, error.message);
        else throw error;
      }
      return { purchase: getPurchaseRow(this.ledger, purchaseId), execution: this.view(purchaseId) };
    });
  }

  /** Startup and lease-expiry reconciliation for every purchase with unresolved execution. */
  async reconcileAll(filter: { jobId?: string; taskId?: string } = {}): Promise<string[]> {
    const rows = this.ledger.db
      .prepare(
        `SELECT p.id FROM purchase p JOIN purchase_input i ON i.purchase_id = p.id
         WHERE p.authorization_state IN ('reserved', 'released') AND p.recovery_state = 'none'
           AND p.fulfilment_state NOT IN ('delivered', 'paid_without_result', 'abandoned')
           AND (? IS NULL OR p.job_id = ?) AND (? IS NULL OR p.task_id = ?)`,
      )
      .pluck()
      .all(filter.jobId ?? null, filter.jobId ?? null, filter.taskId ?? null, filter.taskId ?? null) as string[];
    for (const id of rows) await this.drive(id);
    return rows;
  }

  #setError(purchaseId: string, code: string | null, message: string | null): void {
    this.ledger.db
      .prepare(`UPDATE purchase_execution SET last_error_code = ?, last_error = ?, updated_at_ms = ? WHERE purchase_id = ?`)
      .run(code, message, this.ledger.now(), purchaseId);
  }

  #ensureExecution(p: PurchaseRow): ExecutionRow {
    const path = p.payment_path === "prepaid_credits" ? "usage" : "x402";
    this.ledger.db
      .prepare(`INSERT OR IGNORE INTO purchase_execution (purchase_id, path, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)`)
      .run(p.id, path, this.ledger.now(), this.ledger.now());
    return this.execution(p.id) as ExecutionRow;
  }

  #update(purchaseId: string, fields: Partial<Record<keyof ExecutionRow, unknown>>): void {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    this.ledger.db
      .prepare(`UPDATE purchase_execution SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at_ms = ? WHERE purchase_id = ?`)
      .run(...keys.map((k) => fields[k as keyof ExecutionRow]), this.ledger.now(), purchaseId);
  }

  /** Records a cross-service result exactly once; returns false for a duplicate delivery. */
  #inbox(source: string, eventId: string, topic: string, payload: unknown): boolean {
    const fresh = acceptInbox(this.ledger, source, eventId, topic, payload);
    if (fresh) this.ledger.db.prepare(`UPDATE inbox SET processed_at_ms = ? WHERE event_id = ?`).run(this.ledger.now(), eventId);
    return fresh;
  }

  /** Durable intent for an outbound call, committed before the call is made. */
  #intent(p: PurchaseRow, topic: string, payload: Record<string, unknown> = {}): string {
    return immediate(this.ledger.db, () => enqueueOutbox(this.ledger, topic, p.id, { purchaseId: p.id, operationId: p.operation_id, ...payload }));
  }

  #ack(eventId: string): void {
    markOutboxPublished(this.ledger, eventId);
  }

  async #drive(purchaseId: string): Promise<void> {
    const gateway = this.deps.gateway;
    let p = getPurchaseRow(this.ledger, purchaseId);
    if (p.authorization_state === "awaiting_approval") throw new Blocked("APPROVAL_REQUIRED", "waiting for owner approval");
    if (p.authorization_state === "rejected") return;
    if (!gateway) throw new Blocked("NOT_READY", "gateway integration is not configured");
    const input = this.input(p.id);
    if (!input) throw new Blocked("NOT_READY", "purchase input has not been supplied");
    this.#ensureExecution(p);
    for (let step = 0; step < MAX_STEPS; step += 1) {
      p = getPurchaseRow(this.ledger, purchaseId);
      const progressed =
        p.payment_path === "prepaid_credits" ? await this.#usageStep(p, gateway, input) : await this.#x402Step(p, gateway, input);
      if (!progressed) return;
    }
  }

  // ---- prepaid usage (one permit, one gateway reservation per operation) -----------------------

  async #usageStep(p: PurchaseRow, gateway: GatewayClient, input: Record<string, unknown>): Promise<boolean> {
    if (TERMINAL_FULFILMENT.has(p.fulfilment_state)) return false;
    const ex = this.execution(p.id) as ExecutionRow;

    if (p.authorization_state === "reserved") {
      const permits = this.deps.permits;
      if (!permits) throw new Blocked("NOT_READY", "usage permit signing key is not configured");
      const accountId = await gateway.accountId();
      const sku = p.sku as GatewaySku;
      immediate(this.ledger.db, () => {
        advanceAuthority(this.ledger, p.id, "issue_usage_permit");
        const signed = permits.sign({
          audience: gateway.identity,
          purchaseId: p.id,
          operationId: p.operation_id,
          accountId,
          sku,
          units: big(p.usage_units),
          requestDigest: p.request_digest,
          workspaceId: p.workspace_id,
          agentId: p.agent_id,
          taskId: p.task_id,
          nowMs: this.ledger.now(),
        });
        this.#update(p.id, { usage_permit: signed.permit, usage_permit_nonce: signed.nonce, usage_permit_expires_at_ms: signed.expiresAtMs, gateway_state: "permit_issued" });
        enqueueOutbox(this.ledger, "gateway.usage.authorize", p.id, { purchaseId: p.id, operationId: p.operation_id, nonce: signed.nonce });
      });
      return true;
    }
    if (p.authorization_state !== "released") return false;

    if (ex.usage_reservation_id === null) {
      const expired = this.ledger.now() >= num(ex.usage_permit_expires_at_ms) + PERMIT_PROOF_MARGIN_MS;
      if (expired) {
        const found = await gateway.usageGet(p.operation_id);
        if (found.status === 404) {
          immediate(this.ledger.db, () => {
            if (this.#inbox("gateway", `gw:${p.id}:usage.unreserved`, "usage.unreserved", { operationId: p.operation_id })) {
              recordUsagePreDispatchFailure(this.ledger, p.id);
              this.#update(p.id, { gateway_state: "permit_expired_unreserved" });
            }
          });
          return false;
        }
        if (found.status !== 200) throw new Blocked("NOT_READY", `gateway usage status unavailable (HTTP ${found.status})`);
        this.#adoptReservation(p, found.body);
        return true;
      }
      const outbox = this.#pendingOutbox(p.id, "gateway.usage.authorize");
      const r = await gateway.usageAuthorize(ex.usage_permit as string);
      if (r.status === 200 || r.status === 201) {
        this.#adoptReservation(p, r.body);
        if (outbox) this.#ack(outbox);
        return true;
      }
      const code = (r.body?.error?.code as string | undefined) ?? "PROVIDER_UNAVAILABLE";
      // These replies are definite: the gateway reserved nothing for this operation.
      const definite = ["BUDGET_EXCEEDED", "POLICY_DENIED", "ACCOUNT_STOPPED", "SERVICE_NOT_ALLOWED", "PRICE_CHANGED", "PROVIDER_UNAVAILABLE", "OPERATOR_BUDGET_EXHAUSTED"];
      if (definite.includes(code) && (r.status < 500 || r.status === 503)) {
        immediate(this.ledger.db, () => {
          if (this.#inbox("gateway", `gw:${p.id}:usage.refused`, "usage.refused", { code })) {
            recordUsagePreDispatchFailure(this.ledger, p.id);
            this.#update(p.id, { gateway_state: `refused:${code}` });
          }
        });
        if (outbox) this.#ack(outbox);
        throw new Blocked(code === "BUDGET_EXCEEDED" ? "BUDGET_EXCEEDED" : code, `gateway refused the usage authorization: ${r.body?.error?.message ?? code}`);
      }
      throw new Blocked("NOT_READY", `gateway usage authorization unresolved (HTTP ${r.status}); the same permit will be reconciled`);
    }

    const ev = this.#intent(p, "gateway.usage.execute", { reservationId: ex.usage_reservation_id });
    const r = await gateway.usageExecute(p.operation_id, ex.usage_reservation_id, input);
    if (r.body?.state !== undefined) {
      this.#applyUsage(p, r.body);
      this.#ack(ev);
      return false;
    }
    if (r.status !== 404 && r.status < 500) {
      // A refusal (for example an expired permit) is resolved from the gateway's operation record.
      const s = await gateway.usageGet(p.operation_id);
      if (s.status === 200) {
        this.#applyUsage(p, s.body);
        this.#ack(ev);
        return false;
      }
    }
    throw new Blocked("NOT_READY", `gateway usage execution unresolved (HTTP ${r.status}); reconcile will query the same operation`);
  }

  #pendingOutbox(purchaseId: string, topic: string): string | undefined {
    return this.ledger.db
      .prepare(`SELECT event_id FROM outbox WHERE aggregate_id = ? AND topic = ? AND published_at_ms IS NULL ORDER BY seq DESC LIMIT 1`)
      .pluck()
      .get(purchaseId, topic) as string | undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #adoptReservation(p: PurchaseRow, body: any): void {
    const rid = String(body.reservationId);
    if (body.operationId !== p.operation_id || BigInt(body.units) !== big(p.usage_units) || body.requestDigest !== p.request_digest) {
      throw new Blocked("RECOVERY_REQUIRED", "gateway reservation does not match this operation");
    }
    immediate(this.ledger.db, () => {
      this.#inbox("gateway", `gw:${p.id}:usage.reserved`, "usage.reserved", { reservationId: rid });
      const ex = this.execution(p.id) as ExecutionRow;
      if (ex.usage_reservation_id === null) this.#update(p.id, { usage_reservation_id: rid, gateway_state: String(body.state) });
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #applyUsage(p: PurchaseRow, body: any): void {
    const state = String(body.state);
    immediate(this.ledger.db, () => {
      const current = getPurchaseRow(this.ledger, p.id);
      this.#update(p.id, { gateway_state: state });
      if (state === "completed" || state === "incomplete") {
        if (!this.#inbox("gateway", `gw:${p.id}:usage.consumed`, "usage.consumed", { reservationId: body.reservationId })) return;
        this.#update(p.id, { result_json: JSON.stringify({ state, ...(body.result ?? {}), note: body.note ?? null, onChainCharge: "none" }) });
        recordUsageConsumed(this.ledger, p.id, BigInt(body.units), this.ledger.now());
        if (state === "incomplete") this.ledger.db.prepare(`UPDATE purchase SET state_reason = 'incomplete_result' WHERE id = ?`).run(p.id);
      } else if (state === "released") {
        if (!this.#inbox("gateway", `gw:${p.id}:usage.released`, "usage.released", { reservationId: body.reservationId })) return;
        this.#update(p.id, { result_json: JSON.stringify({ state, error: body.error ?? null }) });
        if (current.fulfilment_state === "not_started") recordUsagePreDispatchFailure(this.ledger, p.id);
      } else if (state === "uncertain") {
        if (!this.#inbox("gateway", `gw:${p.id}:usage.uncertain`, "usage.uncertain", { reservationId: body.reservationId })) return;
        if (current.fulfilment_state === "not_started") transition(this.ledger, p.id, "fulfilment", "not_started", "in_progress");
        markUncertain(this.ledger, p.id, "fulfilment");
        this.#update(p.id, { result_json: JSON.stringify({ state, error: body.error ?? { code: "PAID_NO_RESULT" } }) });
      }
    });
  }

  // ---- direct x402 purchase (private funding leg, then merchant leg) ---------------------------

  #service(p: PurchaseRow): ServiceRow {
    return this.ledger.db.prepare(`SELECT * FROM approved_service WHERE id = ?`).get(p.service_id) as ServiceRow;
  }

  #latestQuote(purchaseId: string): QuoteRow | undefined {
    return this.ledger.db
      .prepare(`SELECT * FROM purchase_quote WHERE purchase_id = ? ORDER BY seq DESC LIMIT 1`)
      .get(purchaseId) as QuoteRow | undefined;
  }

  #binding(p: PurchaseRow, q: QuoteRow): FundingBinding {
    const s = this.#service(p);
    const quote = JSON.parse(q.quote_json) as { recipient: { feePayer: string } };
    return {
      origin: s.origin,
      gatewayIdentity: s.gateway_identity ?? "",
      sku: p.sku,
      network: s.network,
      mint: s.mint,
      payTo: s.recipient ?? "",
      merchantAta: s.recipient_ata ?? "",
      allowedFeePayers: [quote.recipient.feePayer],
    };
  }

  /** Checks the immutable quote against the owner-approved binding and the authorized price. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #quoteProblem(p: PurchaseRow, quote: any): { code: string; message: string } | null {
    const s = this.#service(p);
    if (quote.operationId !== p.operation_id || quote.requestDigest !== p.request_digest || quote.sku !== p.sku) {
      return { code: "IDEMPOTENCY_CONFLICT", message: "quote does not match this operation" };
    }
    if (quote.charge?.unit !== "usdc_base_units" || BigInt(quote.charge.amount) !== big(p.price_usdc)) {
      return { code: "PRICE_CHANGED", message: "quoted charge differs from the authorized price" };
    }
    const r = quote.recipient ?? {};
    if (r.network !== s.network) return { code: "WRONG_NETWORK", message: "quote network differs from the approved binding" };
    if (r.asset !== s.mint) return { code: "WRONG_MINT", message: "quote mint differs from the approved binding" };
    if (r.payTo !== s.recipient || r.merchantAta !== s.recipient_ata || quote.gateway?.identity !== s.gateway_identity || quote.gateway?.origin !== s.origin) {
      return { code: "SERVICE_NOT_ALLOWED", message: "quote recipient or gateway differs from the approved binding" };
    }
    return null;
  }

  async #requestQuote(p: PurchaseRow, gateway: GatewayClient, input: Record<string, unknown>): Promise<QuoteRow> {
    const ev = this.#intent(p, "gateway.quote");
    const r = await gateway.quote(p.operation_id, p.sku, input, p.request_digest);
    if (r.status !== 200 && r.status !== 201) {
      throw new Blocked(r.body?.error?.code ?? "PROVIDER_UNAVAILABLE", `gateway quote unavailable: ${r.body?.error?.message ?? `HTTP ${r.status}`}`);
    }
    this.#ack(ev);
    const problem = this.#quoteProblem(p, r.body);
    if (problem) {
      immediate(this.ledger.db, () => {
        const current = getPurchaseRow(this.ledger, p.id);
        if (current.authorization_state === "reserved" && ["not_started", "proof_prepared"].includes(current.funding_state)) {
          cancelUnreleased(this.ledger, current, "rejected");
        }
        writeAudit(this.ledger, {
          workspaceId: p.workspace_id,
          scope: `purchase:${p.id}`,
          actorType: "system",
          actorId: null,
          action: "purchase.quote_rejected",
          policyResult: "denied",
          reasonCode: problem.code,
          details: { reason: problem.message },
        });
      });
      throw new Blocked(problem.code, problem.message);
    }
    return immediate(this.ledger.db, () => {
      const existing = this.ledger.db.prepare(`SELECT * FROM purchase_quote WHERE quote_id = ?`).get(r.body.quoteId) as QuoteRow | undefined;
      if (existing) return existing;
      const latest = this.#latestQuote(p.id);
      this.ledger.db
        .prepare(
          `INSERT INTO purchase_quote (purchase_id, seq, quote_id, charge_usdc, quote_json, expires_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(p.id, latest ? latest.seq + 1n : 1n, r.body.quoteId, BigInt(r.body.charge.amount), JSON.stringify(r.body), Date.parse(r.body.expiresAt), this.ledger.now());
      if (latest) {
        writeAudit(this.ledger, {
          workspaceId: p.workspace_id,
          scope: `purchase:${p.id}`,
          actorType: "system",
          actorId: null,
          action: "purchase.requote",
          policyResult: "allowed",
          details: { previousQuoteId: latest.quote_id, quoteId: r.body.quoteId, fundingReused: p.funding_state === "finalized" },
        });
      }
      return this.#latestQuote(p.id) as QuoteRow;
    });
  }

  async #x402Step(p: PurchaseRow, gateway: GatewayClient, input: Record<string, unknown>): Promise<boolean> {
    if (p.recovery_state !== "none") return false;
    if (p.merchant_state === "finalized" && TERMINAL_FULFILMENT.has(p.fulfilment_state)) return false;
    if (["expired_unsettled", "abandoned"].includes(p.funding_state)) return false;

    const quote = this.#latestQuote(p.id);
    if (!quote) {
      if (p.authorization_state !== "reserved" && p.funding_state !== "finalized") return false;
      await this.#requestQuote(p, gateway, input);
      return true;
    }

    switch (p.funding_state) {
      case "not_started":
        if (p.authorization_state !== "reserved") return false;
        // Authority is rechecked and recorded first; the wallet prepares only for this stage.
        advanceAuthority(this.ledger, p.id, "prepare_proof");
        return true;
      case "proof_prepared":
        return (this.execution(p.id) as ExecutionRow).funding_ref === null ? this.#fundingPrepare(p, quote) : this.#fundingRelease(p);
      case "proof_released":
      case "submitted":
      case "uncertain":
        return this.#applyFunding(p, await this.deps.funding.status(p.id));
      case "finalized":
        break;
      default:
        return false;
    }

    if (p.merchant_state === "not_started") {
      const ch = await gateway.execute(quote.quote_id, p.operation_id, p.request_digest);
      if (ch.status === 410) {
        // Re-quote: no merchant authorization exists and the gateway has no payment for this
        // operation; existing funding is reused, never withdrawn again.
        immediate(this.ledger.db, () => assertAuthorityCurrent(this.ledger, getPurchaseRow(this.ledger, p.id)));
        await this.#requestQuote(p, gateway, input);
        return true;
      }
      if (ch.status !== 402) {
        if (ch.body?.state !== undefined) return this.#applyGatewayPurchase(p, ch.body);
        throw new Blocked(ch.body?.error?.code ?? "PROVIDER_UNAVAILABLE", `gateway challenge unavailable: ${ch.body?.error?.message ?? `HTTP ${ch.status}`}`);
      }
      const paymentRequired = withoutQuoteId(ch.body);
      advanceAuthority(this.ledger, p.id, "sign_merchant");
      return this.#signAndPay(getPurchaseRow(this.ledger, p.id), gateway, quote, paymentRequired);
    }
    if (p.merchant_state === "signed") {
      const ex = this.execution(p.id) as ExecutionRow;
      if (ex.merchant_message_hash === null) {
        const ch = await gateway.execute(quote.quote_id, p.operation_id, p.request_digest);
        if (ch.status !== 402) {
          if (ch.body?.state !== undefined) return this.#applyGatewayPurchase(p, ch.body);
          throw new Blocked("RECOVERY_REQUIRED", "merchant leg was authorized but no payment was signed; waiting for reconciliation");
        }
        const paymentRequired = withoutQuoteId(ch.body);
        return this.#signAndPay(p, gateway, quote, paymentRequired);
      }
      return this.#signAndPay(p, gateway, quote, undefined);
    }
    if (p.merchant_state === "submitted" || p.merchant_state === "uncertain" || p.merchant_state === "finalized") {
      const r = await gateway.result(quote.quote_id);
      if (r.body?.state === undefined) throw new Blocked("SETTLEMENT_UNCERTAIN", `gateway result unavailable (HTTP ${r.status})`);
      return this.#applyGatewayPurchase(p, r.body);
    }
    return false;
  }

  async #fundingPrepare(p: PurchaseRow, quote: QuoteRow): Promise<boolean> {
    if (p.authorization_state !== "reserved") return false;
    const note = reservedNoteFor(this.ledger, p.id);
    if (!note) throw new Blocked("RECOVERY_REQUIRED", "purchase has no reserved pool note");
    const ev = this.#intent(p, "wallet.funding.prepare");
    const r = await this.deps.funding.prepare({
      purchaseId: p.id,
      operationId: p.operation_id,
      payoutUsdc: big(p.price_usdc),
      tokenFeeCapUsdc: big(p.fee_cap_usdc),
      sponsorLamportCap: big(p.sponsor_lamports),
      inputNote: { commitment: note.commitment, value: big(note.value) },
      binding: this.#binding(p, quote),
    });
    if (r.status !== "prepared") {
      throw new Blocked(r.status === "not_ready" ? "NOT_READY" : "RECOVERY_REQUIRED", `private funding not available: ${"reason" in r ? r.reason : r.status}`);
    }
    this.#ack(ev);
    this.#update(p.id, { funding_ref: r.fundingRef, merchant_payer: r.payer });
    return true;
  }

  async #fundingRelease(p: PurchaseRow): Promise<boolean> {
    const ex = this.execution(p.id) as ExecutionRow;
    advanceAuthority(this.ledger, p.id, "release_proof");
    this.#intent(p, "wallet.funding.release", { fundingRef: ex.funding_ref });
    return this.#applyFunding(getPurchaseRow(this.ledger, p.id), await this.deps.funding.release(p.id, ex.funding_ref as string));
  }

  #applyFunding(p: PurchaseRow, r: FundingResult): boolean {
    switch (r.status) {
      case "not_ready":
      case "recovery_required":
        throw new Blocked(r.status === "not_ready" ? "NOT_READY" : "RECOVERY_REQUIRED", `funding outcome unavailable: ${r.reason}`);
      case "prepared":
        return false;
      case "submitted":
        immediate(this.ledger.db, () => {
          const cur = getPurchaseRow(this.ledger, p.id);
          if (cur.funding_state === "proof_released") transition(this.ledger, p.id, "funding", "proof_released", "submitted");
          if (r.signature) this.#chainAttempt(p.id, "funding", 1, r.signature, "processed");
        });
        throw new Blocked("SETTLEMENT_UNCERTAIN", "Withdrawal outcome pending");
      case "uncertain":
        markUncertain(this.ledger, p.id, "funding");
        throw new Blocked("SETTLEMENT_UNCERTAIN", `Withdrawal outcome pending: ${r.reason}`);
      case "expired_unsettled":
        immediate(this.ledger.db, () => {
          if (this.#inbox("wallet", `wallet:${p.id}:funding.expired`, "funding.expired", { fundingRef: r.fundingRef })) {
            recordFundingExpiredUnsettled(this.ledger, p.id);
          }
        });
        return false;
      case "finalized": {
        const e = r.evidence;
        immediate(this.ledger.db, () => {
          if (!this.#inbox("wallet", `wallet:${p.id}:funding.finalized`, "funding.finalized", { signature: e.signature })) return;
          recordFundingFinalized(this.ledger, p.id, {
            payout: e.payout,
            tokenFees: e.tokenFees,
            change: e.change,
            changeCommitment: e.changeCommitment,
            observedAtMs: e.observedAtMs,
          });
          this.#chainAttempt(p.id, "funding", 1, e.signature, "finalized");
          this.#update(p.id, { funding_token_fees: e.tokenFees, sponsor_lamports_spent: e.sponsorLamportsSpent });
        });
        return true;
      }
    }
  }

  #chainAttempt(purchaseId: string, leg: "funding" | "merchant", attemptNo: number, signature: string | null, commitment: string, extra: { blockhash?: string; lastValid?: bigint } = {}): void {
    const now = this.ledger.now();
    this.ledger.db
      .prepare(
        `INSERT OR IGNORE INTO chain_attempt (id, purchase_id, leg, attempt_no, signature, blockhash, last_valid_block_height, observed_commitment, observed_at_ms, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(this.ledger.newId(), purchaseId, leg, attemptNo, signature, extra.blockhash ?? null, extra.lastValid ?? null, commitment, now, now);
    this.ledger.db
      .prepare(
        `UPDATE chain_attempt SET signature = ifnull(signature, ?), observed_commitment = ?, observed_at_ms = ?
         WHERE purchase_id = ? AND leg = ? AND attempt_no = ?`,
      )
      .run(signature, commitment, now, purchaseId, leg, attemptNo);
  }

  async #signAndPay(p: PurchaseRow, gateway: GatewayClient, quote: QuoteRow, paymentRequired: Record<string, unknown> | undefined): Promise<boolean> {
    const ex = this.execution(p.id) as ExecutionRow;
    const ev = this.#intent(p, "wallet.merchant.sign", { quoteId: quote.quote_id });
    const signed = await this.deps.funding.signMerchantPayment({
      purchaseId: p.id,
      fundingRef: ex.funding_ref as string,
      paymentRequired: paymentRequired ?? null,
      binding: this.#binding(p, quote),
      exactAmountUsdc: big(p.price_usdc),
    });
    if (signed.status !== "signed") {
      throw new Blocked(signed.status === "not_ready" ? "NOT_READY" : "RECOVERY_REQUIRED", `merchant payment not signed: ${signed.reason}`);
    }
    this.#ack(ev);
    immediate(this.ledger.db, () => {
      if (ex.merchant_message_hash === null) this.#update(p.id, { merchant_message_hash: signed.messageHash, merchant_payer: signed.payer });
      const accepts = (paymentRequired?.accepts as Array<{ extra?: Record<string, unknown> }> | undefined)?.[0]?.extra;
      this.#chainAttempt(p.id, "merchant", 1, null, "unknown", {
        ...(typeof accepts?.recentBlockhash === "string" ? { blockhash: accepts.recentBlockhash } : {}),
        ...(typeof accepts?.lastValidBlockHeight === "string" ? { lastValid: BigInt(accepts.lastValidBlockHeight) } : {}),
      });
    });
    const payEv = this.#intent(p, "gateway.x402.execute", { quoteId: quote.quote_id });
    const r: GatewayResponse = await gateway.execute(quote.quote_id, p.operation_id, p.request_digest, signed.paymentSignatureHeader);
    if (r.body?.state === undefined) {
      throw new Blocked(r.body?.error?.code ?? "SETTLEMENT_UNCERTAIN", `merchant payment not accepted: ${r.body?.error?.message ?? `HTTP ${r.status}`}`);
    }
    this.#ack(payEv);
    return this.#applyGatewayPurchase(p, r.body);
  }

  /** Maps the gateway's durable purchase record onto the merchant and fulfilment legs. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #applyGatewayPurchase(p: PurchaseRow, body: any): boolean {
    const state = String(body.state);
    const payment = body.payment as { txSignature?: string | null; amount?: string; finalizedSlot?: string; observedAt?: string } | null;
    immediate(this.ledger.db, () => {
      let cur = getPurchaseRow(this.ledger, p.id);
      const ex = this.execution(p.id) as ExecutionRow;
      this.#update(p.id, { gateway_state: state });
      if (payment?.finalizedSlot !== undefined && payment.txSignature) {
        if (cur.merchant_state !== "finalized" && this.#inbox("gateway", `gw:${p.id}:x402.payment`, "x402.payment", { signature: payment.txSignature })) {
          if (cur.merchant_state === "not_started") throw new Blocked("RECOVERY_REQUIRED", "gateway reports a payment this purchase never authorized");
          recordMerchantFinalized(this.ledger, p.id, {
            merchantAmount: BigInt(payment.amount as string),
            tokenFees: ex.funding_token_fees === null ? 0n : big(ex.funding_token_fees),
            sponsorLamports: ex.sponsor_lamports_spent === null ? 0n : big(ex.sponsor_lamports_spent),
            settledAtMs: Date.parse(payment.observedAt as string),
          });
          this.#chainAttempt(p.id, "merchant", 1, payment.txSignature, "finalized");
        }
      } else if (state === "pending_settlement" && cur.merchant_state === "signed") {
        transition(this.ledger, p.id, "merchant", "signed", "submitted");
        if (payment?.txSignature) this.#chainAttempt(p.id, "merchant", 1, payment.txSignature, "processed");
      } else if (state === "unpaid" && ["signed", "submitted", "uncertain"].includes(cur.merchant_state) && ex.merchant_message_hash !== null) {
        // The gateway proved the claimed payment expired without settling: funded wallet is recoverable.
        transition(this.ledger, p.id, "merchant", cur.merchant_state, "expired_unsettled", "merchant payment expired unsettled");
        if (cur.fulfilment_state === "not_started") transition(this.ledger, p.id, "fulfilment", "not_started", "abandoned");
        markRecoverable(this.ledger, p.id, "merchant payment expired unsettled; funded wallet recoverable by the owner");
        return;
      }
      cur = getPurchaseRow(this.ledger, p.id);
      const toFulfil = (to: "in_progress" | "delivered" | "paid_without_result") => {
        let f = getPurchaseRow(this.ledger, p.id).fulfilment_state;
        if (f === to || TERMINAL_FULFILMENT.has(f)) return;
        if (f === "not_started") {
          transition(this.ledger, p.id, "fulfilment", "not_started", "in_progress");
          f = "in_progress";
        }
        if (to !== "in_progress") transition(this.ledger, p.id, "fulfilment", f, to);
      };
      if (cur.merchant_state !== "finalized") return;
      if (state === "delivered" || state === "incomplete") {
        this.#update(p.id, { result_json: JSON.stringify({ state, ...(body.result ?? {}), prepaidCreditsDebited: body.prepaidCreditsDebited ?? "0" }) });
        toFulfil("delivered");
        if (state === "incomplete") this.ledger.db.prepare(`UPDATE purchase SET state_reason = 'incomplete_result' WHERE id = ?`).run(p.id);
      } else if (state === "paid_no_result") {
        this.#update(p.id, { result_json: JSON.stringify({ state, error: body.error ?? null }) });
        toFulfil("paid_without_result");
      } else if (state === "paid_fulfilment_pending" || state === "paid_awaiting_provider") {
        toFulfil("in_progress");
      }
    });
    const after = getPurchaseRow(this.ledger, p.id);
    if (after.merchant_state === "submitted" || after.fulfilment_state === "in_progress") {
      throw new Blocked("SETTLEMENT_UNCERTAIN", state === "pending_settlement" ? "Waiting for confirmation" : "Paid; waiting for the provider");
    }
    return false;
  }
}
