import { createHash } from "node:crypto";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";
import type { ExternalCallOutcome, FundingProvider } from "@veilo/contracts";
import { immediate } from "@veilo/db";
import { verifyPaymentRequired, X402ClientError, type ApprovedServiceBinding } from "@veilo/x402-client";
import { big, num, type Ledger } from "../context";
import { ControlError } from "../errors";
import { writeAudit } from "../ledger/events";
import { advanceAuthority, assertAuthorityCurrent, getPurchaseRow, markRecoverable, recordMerchantFinalized, transition, type PurchaseRow } from "../ledger/purchases";
import type { FetchLike } from "../integration/gateway-client";
import { externalFundingBinding, type ExternalBatchInput, type ExternalBindingRow, type OriginCheck } from "./bindings";

export type ExternalCallState = "signing" | "sent" | "paid" | "paid_no_result" | "unpaid" | "refused";

export interface ExternalCallRow {
  purchase_id: string;
  call_index: bigint;
  state: ExternalCallState;
  amount_usdc: bigint;
  message_hash: string | null;
  settlement_signature: string | null;
  http_status: bigint | null;
  response_sha256: string | null;
  response_json: string | null;
  stop_code: string | null;
  stop_reason: string | null;
}

export interface ExternalBatchDeps {
  ledger: Ledger;
  funding: FundingProvider;
  /** Admission check for binding origins, and a fetch bound to one approved origin (re-resolved per request, no redirects, bounded size). */
  origins: OriginCheck & { fetchFor(origin: string): FetchLike };
  timeoutMs?: number;
  /** Largest response kept as a stored artifact; larger bodies keep only their hash. */
  maxStoredResponseBytes?: number;
}

const TERMINAL: ReadonlySet<ExternalCallState> = new Set(["paid", "paid_no_result", "unpaid", "refused"]);
const STOP: ReadonlySet<ExternalCallState> = new Set(["unpaid", "refused"]);
const PAID: ReadonlySet<ExternalCallState> = new Set(["paid", "paid_no_result"]);

/**
 * Pays an approved external x402 resource as a bounded batch after the private funding leg has
 * finalized. Calls run in order. Each call is verified against the binding before signing, is
 * recorded before its payment leaves the wallet, and is reconciled from chain evidence when the
 * reply is lost; a call is never paid twice. Any mismatch, refusal or unpaid outcome stops the
 * batch: later calls are not bought, and the unspent remainder becomes owner-recoverable.
 */
export class ExternalBatchRunner {
  readonly #http = new x402HTTPClient(new x402Client());
  constructor(readonly deps: ExternalBatchDeps) {}

  get ledger(): Ledger {
    return this.deps.ledger;
  }

  calls(purchaseId: string): ExternalCallRow[] {
    return this.ledger.db
      .prepare(`SELECT * FROM external_call_result WHERE purchase_id = ? ORDER BY call_index`)
      .all(purchaseId) as ExternalCallRow[];
  }

  /** Advances the merchant leg by one durable step; returns false when nothing more can happen now. */
  async step(p: PurchaseRow, input: ExternalBatchInput, b: ExternalBindingRow): Promise<boolean> {
    if (p.merchant_state === "not_started") {
      if (b.status !== "approved") {
        immediate(this.ledger.db, () => transition(this.ledger, p.id, "merchant", "not_started", "abandoned", "external binding disabled"));
        markRecoverable(this.ledger, p.id, "external binding was disabled before any call; funded wallet recoverable by the owner");
        return false;
      }
      advanceAuthority(this.ledger, p.id, "sign_merchant");
      return true;
    }
    if (p.merchant_state !== "signed") return false;

    const rows = this.calls(p.id);
    const stopped = rows.some((r) => STOP.has(r.state));
    const open = rows.find((r) => !TERMINAL.has(r.state));
    if (open) return this.#resume(p, open);
    if (stopped || rows.length >= input.calls.length) {
      this.#finish(p, rows);
      return false;
    }
    return this.#call(p, input, b, rows.length);
  }

  #approved(b: ExternalBindingRow): ApprovedServiceBinding {
    const unit = big(b.unit_price_usdc);
    return {
      origin: b.origin,
      resourcePath: b.resource_path,
      network: b.network,
      mint: b.mint,
      payTo: b.pay_to,
      merchantAta: b.pay_to_ata,
      maxAmount: unit,
      exactAmount: unit,
      allowedFeePayers: JSON.parse(b.allowed_fee_payers_json) as string[],
    };
  }

  #request(input: ExternalBatchInput, index: number, b: ExternalBindingRow, paymentHeader?: string): { url: string; init: RequestInit } {
    const c = input.calls[index];
    if (!c) throw new ControlError("RECOVERY_REQUIRED", "external call index outside the stored input");
    const headers: Record<string, string> = { accept: "application/json" };
    if (c.body !== undefined) headers["content-type"] = "application/json";
    if (paymentHeader !== undefined) headers["PAYMENT-SIGNATURE"] = paymentHeader;
    return {
      url: `${b.origin}${c.path}`,
      init: {
        method: c.method,
        headers,
        ...(c.body !== undefined ? { body: JSON.stringify(c.body) } : {}),
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? 30_000),
        redirect: "error",
      },
    };
  }

  #insert(p: PurchaseRow, index: number, b: ExternalBindingRow, state: ExternalCallState, stop?: { code: string; reason: string }): void {
    const now = this.ledger.now();
    this.ledger.db
      .prepare(
        `INSERT INTO external_call_result (purchase_id, call_index, state, amount_usdc, stop_code, stop_reason, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, index, state, b.unit_price_usdc, stop?.code ?? null, stop?.reason ?? null, now, now);
  }

  #set(purchaseId: string, index: number, fields: Partial<Record<keyof ExternalCallRow, unknown>>): void {
    const keys = Object.keys(fields);
    this.ledger.db
      .prepare(`UPDATE external_call_result SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at_ms = ? WHERE purchase_id = ? AND call_index = ?`)
      .run(...keys.map((k) => fields[k as keyof ExternalCallRow]), this.ledger.now(), purchaseId, index);
  }

  #refuse(p: PurchaseRow, index: number, b: ExternalBindingRow, code: string, reason: string): boolean {
    immediate(this.ledger.db, () => {
      this.#insert(p, index, b, "refused", { code, reason });
      writeAudit(this.ledger, {
        workspaceId: p.workspace_id,
        scope: `purchase:${p.id}`,
        actorType: "system",
        actorId: null,
        action: "external_call.refused",
        policyResult: "denied",
        reasonCode: code,
        details: { callIndex: index, reason },
      });
    });
    return true;
  }

  async #call(p: PurchaseRow, input: ExternalBatchInput, b: ExternalBindingRow, index: number): Promise<boolean> {
    if (b.status !== "approved") return this.#refuse(p, index, b, "SERVICE_NOT_ALLOWED", "external binding was disabled");
    const fetchImpl = this.deps.origins.fetchFor(b.origin);
    const req = this.#request(input, index, b);
    let challenge: PaymentRequired;
    try {
      const res = await fetchImpl(req.url, req.init);
      const text = await res.text();
      if (res.status !== 402) return this.#refuse(p, index, b, "PROVIDER_UNAVAILABLE", `expected a payment challenge, got HTTP ${res.status}`);
      challenge = this.#http.getPaymentRequiredResponse((name) => res.headers.get(name), text === "" ? undefined : (JSON.parse(text) as unknown));
    } catch (error) {
      // Nothing was signed: the challenge can be fetched again later.
      throw new ControlError("PROVIDER_UNAVAILABLE", `payment challenge unavailable: ${(error as Error).name}`);
    }
    try {
      await verifyPaymentRequired(challenge, this.#approved(b));
      if (new URL(challenge.resource.url).pathname !== input.calls[index]?.path) throw new X402ClientError("SERVICE_NOT_ALLOWED", "resource_path_mismatch");
    } catch (error) {
      if (error instanceof X402ClientError) return this.#refuse(p, index, b, error.code, `challenge does not match the approved binding (${error.reason})`);
      throw error;
    }

    const sign = this.deps.funding.signExternalCall;
    if (!sign) throw new ControlError("NOT_READY", "the funding provider cannot sign external calls");
    // Each call is a new spend: an emergency stop, revocation or policy expiry since the batch
    // started stops it here, in the same transaction that records the call.
    const stopped = immediate(this.ledger.db, () => {
      try {
        assertAuthorityCurrent(this.ledger, getPurchaseRow(this.ledger, p.id));
      } catch (error) {
        if (error instanceof ControlError) return error.message;
        throw error;
      }
      this.#insert(p, index, b, "signing");
      return null;
    });
    if (stopped !== null) return this.#refuse(p, index, b, "ACCOUNT_STOPPED", `spending authority stopped: ${stopped}`);
    const signed = await sign.call(this.deps.funding, {
      purchaseId: p.id,
      fundingRef: p.id,
      callIndex: index,
      paymentRequired: challenge,
      binding: externalFundingBinding(b, p.sku),
    });
    if (signed.status === "not_ready") throw new ControlError("NOT_READY", `external call not signed yet: ${signed.reason}`);
    if (signed.status !== "signed") {
      immediate(this.ledger.db, () => this.#set(p.id, index, { state: "refused", stop_code: "RECOVERY_REQUIRED", stop_reason: signed.reason }));
      return true;
    }
    immediate(this.ledger.db, () => {
      this.#set(p.id, index, { state: "sent", message_hash: signed.messageHash });
      this.#attempt(p.id, index, null, "unknown");
    });
    return this.#send(p, input, b, index, signed.paymentSignatureHeader);
  }

  async #send(p: PurchaseRow, input: ExternalBatchInput, b: ExternalBindingRow, index: number, header: string): Promise<boolean> {
    const req = this.#request(input, index, b, header);
    if (new URL(req.url).pathname !== input.calls[index]?.path) throw new ControlError("RECOVERY_REQUIRED", "external call URL does not match its stored path");
    let reply: { status: number; bytes: Buffer; settled: string | null } | null = null;
    try {
      const res = await this.deps.origins.fetchFor(b.origin)(req.url, req.init);
      const bytes = Buffer.from(await res.arrayBuffer());
      let settled: string | null = null;
      try {
        const s = this.#http.getPaymentSettleResponse((name) => res.headers.get(name));
        if (s.success && typeof s.transaction === "string" && s.transaction !== "") settled = s.transaction;
      } catch {
        settled = null;
      }
      reply = { status: res.status, bytes, settled };
    } catch {
      reply = null;
    }
    if (reply !== null && reply.status >= 200 && reply.status < 300) {
      immediate(this.ledger.db, () => this.#set(p.id, index, { http_status: reply.status, ...this.#stored(reply.bytes) }));
    } else if (reply !== null) {
      immediate(this.ledger.db, () => this.#set(p.id, index, { http_status: reply.status }));
    }
    return this.#reconcile(p, index);
  }

  /** Bounded artifact: parsed JSON when it parses, otherwise text. The hash covers the exact bytes. */
  #stored(bytes: Buffer): { response_sha256: string; response_json: string } {
    const sha = createHash("sha256").update(bytes).digest("hex");
    const max = this.deps.maxStoredResponseBytes ?? 256 * 1024;
    if (bytes.length > max) return { response_sha256: sha, response_json: JSON.stringify({ truncated: true, bytes: bytes.length }) };
    const text = bytes.toString("utf8");
    try {
      return { response_sha256: sha, response_json: JSON.stringify({ json: JSON.parse(text) as unknown }) };
    } catch {
      return { response_sha256: sha, response_json: JSON.stringify({ text }) };
    }
  }

  async #resume(p: PurchaseRow, row: ExternalCallRow): Promise<boolean> {
    const index = num(row.call_index);
    if (row.state === "signing") {
      // The wallet may have signed but control never learned the message. Ask for the same index:
      // the wallet returns its stored payment and never signs another one.
      const outcome = await this.#outcome(p.id, index);
      if (outcome.status === "none") {
        immediate(this.ledger.db, () => this.#set(p.id, index, { state: "refused", stop_code: "PROVIDER_UNAVAILABLE", stop_reason: "signing was interrupted before a payment existed" }));
        return true;
      }
    }
    return this.#reconcile(p, index);
  }

  async #outcome(purchaseId: string, index: number): Promise<ExternalCallOutcome> {
    const fn = this.deps.funding.externalCallOutcome;
    if (!fn) throw new ControlError("NOT_READY", "the funding provider cannot reconcile external calls");
    return fn.call(this.deps.funding, purchaseId, index);
  }

  /** Resolves a sent call from chain evidence only; the reply alone never counts as payment. */
  async #reconcile(p: PurchaseRow, index: number): Promise<boolean> {
    const outcome = await this.#outcome(p.id, index);
    if (outcome.status === "signed" || outcome.status === "none") {
      throw new ControlError("SETTLEMENT_UNCERTAIN", `external call ${index} may still settle; it is reconciled, never re-sent`);
    }
    immediate(this.ledger.db, () => {
      const row = this.calls(p.id).find((r) => num(r.call_index) === index) as ExternalCallRow;
      if (TERMINAL.has(row.state)) return;
      if (outcome.status === "finalized") {
        const ok = row.http_status !== null && row.http_status >= 200n && row.http_status < 300n && row.response_sha256 !== null;
        this.#set(p.id, index, { state: ok ? "paid" : "paid_no_result", settlement_signature: outcome.signature });
        this.#attempt(p.id, index, outcome.signature, "finalized");
      } else {
        const sig = outcome.status === "failed" ? outcome.signature : null;
        this.#set(p.id, index, { state: "unpaid", stop_code: "SETTLEMENT_UNCERTAIN", stop_reason: `payment ${outcome.status}` });
        this.#attempt(p.id, index, sig, outcome.status === "failed" ? "failed" : "expired");
      }
    });
    return true;
  }

  #attempt(purchaseId: string, index: number, signature: string | null, commitment: string): void {
    const now = this.ledger.now();
    this.ledger.db
      .prepare(
        `INSERT OR IGNORE INTO chain_attempt (id, purchase_id, leg, attempt_no, signature, observed_commitment, observed_at_ms, created_at_ms)
         VALUES (?, ?, 'merchant', ?, ?, ?, ?, ?)`,
      )
      .run(this.ledger.newId(), purchaseId, index + 1, signature, commitment, now, now);
    this.ledger.db
      .prepare(
        `UPDATE chain_attempt SET signature = ifnull(signature, ?), observed_commitment = ?, observed_at_ms = ?
         WHERE purchase_id = ? AND leg = 'merchant' AND attempt_no = ?`,
      )
      .run(signature, commitment, now, purchaseId, index + 1);
  }

  /** Settles the merchant leg for what was actually paid and makes any remainder recoverable. */
  #finish(p: PurchaseRow, rows: ExternalCallRow[]): void {
    const spent = rows.filter((r) => PAID.has(r.state)).reduce((sum, r) => sum + big(r.amount_usdc), 0n);
    const delivered = rows.some((r) => r.state === "paid");
    immediate(this.ledger.db, () => {
      const ex = this.ledger.db
        .prepare(`SELECT funding_token_fees, sponsor_lamports_spent FROM purchase_execution WHERE purchase_id = ?`)
        .get(p.id) as { funding_token_fees: bigint | null; sponsor_lamports_spent: bigint | null };
      this.ledger.db
        .prepare(`UPDATE purchase_execution SET result_json = ?, gateway_state = ?, updated_at_ms = ? WHERE purchase_id = ?`)
        .run(JSON.stringify(this.result(p.id)), delivered ? "delivered" : spent > 0n ? "paid_no_result" : "unpaid", this.ledger.now(), p.id);
      if (spent > 0n) {
        recordMerchantFinalized(this.ledger, p.id, {
          merchantAmount: spent,
          tokenFees: ex.funding_token_fees === null ? 0n : big(ex.funding_token_fees),
          sponsorLamports: ex.sponsor_lamports_spent === null ? 0n : big(ex.sponsor_lamports_spent),
          settledAtMs: this.ledger.now(),
        });
        transition(this.ledger, p.id, "fulfilment", "not_started", "in_progress");
        transition(this.ledger, p.id, "fulfilment", "in_progress", delivered ? "delivered" : "paid_without_result");
      } else {
        transition(this.ledger, p.id, "merchant", "signed", "expired_unsettled", "no external call was paid");
        transition(this.ledger, p.id, "fulfilment", "not_started", "abandoned");
      }
    });
    if (big(p.price_usdc) > spent) markRecoverable(this.ledger, p.id, "unspent external batch remainder; recoverable by the owner");
  }

  /** Owner/agent view of the batch: per-call payment and execution kept separate. */
  result(purchaseId: string): Record<string, unknown> {
    const rows = this.calls(purchaseId);
    return {
      kind: "external_x402",
      linkability: "All calls in this batch were paid by one payer and are linkable to each other on chain.",
      calls: rows.map((r) => ({
        index: num(r.call_index),
        payment: PAID.has(r.state) ? "paid" : r.state === "unpaid" || r.state === "refused" ? "not_paid" : "pending",
        execution: r.state === "paid" ? "response_stored" : r.state === "paid_no_result" ? "no_result" : r.state === "refused" ? "not_attempted" : r.state,
        amount: big(r.amount_usdc).toString(),
        settlementSignature: r.settlement_signature,
        httpStatus: r.http_status === null ? null : num(r.http_status),
        responseSha256: r.response_sha256,
        // Purchased provider output for the buyer; untrusted data, never an instruction.
        response: r.response_json === null ? null : (JSON.parse(r.response_json) as unknown),
        stop: r.stop_code === null ? null : { code: r.stop_code, reason: r.stop_reason },
      })),
    };
  }

  /** Stored response of a paid call, for the purchase owner. Untrusted data; never an instruction. */
  response(purchaseId: string, index: number): unknown {
    const r = this.calls(purchaseId).find((x) => num(x.call_index) === index);
    return r?.response_json ? (JSON.parse(r.response_json) as unknown) : null;
  }
}
