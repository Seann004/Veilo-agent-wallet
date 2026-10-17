import {
  canTransition,
  checkedAdd,
  paymentStatusLabel,
  type AuthorizationState,
  type FulfilmentState,
  type FundingState,
  type MerchantState,
  type PaymentPath,
  type PaymentStateField,
  type RecoveryState,
} from "@veilo/contracts";
import { immediate } from "@veilo/db";
import { big, iso, num, optIso, type Ledger } from "../context";
import { ControlError } from "../errors";
import { appendFinancialEvent, enqueueOutbox, writeAudit } from "./events";
import { appendTokenEvent, consumeReservedNote, unreserveNote, type WithdrawalOutcome } from "./notes";
import type { AgentRow, WorkspaceRow } from "./workspace";

export interface PurchaseRow {
  id: string;
  workspace_id: string;
  operation_id: string;
  idempotency_key: string;
  agent_id: string;
  task_id: string | null;
  job_id: string | null;
  service_id: string;
  sku: string;
  payment_path: PaymentPath;
  request_digest: string;
  price_usdc: bigint;
  fee_cap_usdc: bigint;
  sponsor_lamports: bigint;
  usage_units: bigint;
  quote_id: string | null;
  quote_json: string | null;
  policy_snapshot_json: string;
  workspace_policy_version: bigint;
  agent_policy_version: bigint;
  agent_epoch: bigint;
  stop_epoch: bigint;
  rationale: string | null;
  authorization_state: AuthorizationState;
  funding_state: FundingState;
  merchant_state: MerchantState;
  fulfilment_state: FulfilmentState;
  recovery_state: RecoveryState;
  state_reason: string | null;
  settled_at_ms: bigint | null;
  created_at_ms: bigint;
  updated_at_ms: bigint;
}

interface ReservationRow {
  id: string;
  purchase_id: string;
  reserved_usdc: bigint;
  reserved_lamports: bigint;
  reserved_usage_units: bigint;
  status: "active" | "settled" | "released";
  close_reason: string | null;
}

export function getPurchaseRow(ledger: Ledger, purchaseId: string): PurchaseRow {
  const row = ledger.db.prepare(`SELECT * FROM purchase WHERE id = ?`).get(purchaseId) as PurchaseRow | undefined;
  if (!row) throw new ControlError("NOT_FOUND", "purchase not found");
  return row;
}

function reservationFor(ledger: Ledger, purchaseId: string): ReservationRow {
  return ledger.db.prepare(`SELECT * FROM reservation WHERE purchase_id = ?`).get(purchaseId) as ReservationRow;
}

const COLUMN: Record<PaymentStateField, string> = {
  authorization: "authorization_state",
  funding: "funding_state",
  merchant: "merchant_state",
  fulfilment: "fulfilment_state",
  recovery: "recovery_state",
};

/** Compare-and-set transition of one leg; the database trigger enforces the same edge set. */
export function transition(
  ledger: Ledger,
  purchaseId: string,
  field: PaymentStateField,
  from: string,
  to: string,
  reason?: string,
): void {
  if (!canTransition(field, from, to)) {
    throw new ControlError("RECOVERY_REQUIRED", `invalid ${field} transition ${from} -> ${to}`);
  }
  const col = COLUMN[field];
  const r = ledger.db
    .prepare(`UPDATE purchase SET ${col} = ?, state_reason = ifnull(?, state_reason), updated_at_ms = ? WHERE id = ? AND ${col} = ?`)
    .run(to, reason ?? null, ledger.now(), purchaseId, from);
  if (r.changes !== 1) throw new ControlError("IDEMPOTENCY_CONFLICT", `purchase ${field} state changed concurrently`);
}

function closeReservation(
  ledger: Ledger,
  p: PurchaseRow,
  status: "settled" | "released",
  reason: "settled" | "rejected" | "authority_stopped" | "proven_unsettled" | "recovered" | "pre_dispatch_failure",
): void {
  const res = reservationFor(ledger, p.id);
  if (res.status !== "active") return;
  const now = ledger.now();
  ledger.db
    .prepare(`UPDATE reservation SET status = ?, close_reason = ?, closed_at_ms = ? WHERE id = ? AND status = 'active'`)
    .run(status, reason, now, res.id);
  const kind = status === "settled" ? "reservation_settled" : "reservation_released";
  for (const [asset, amount] of [
    ["usdc", big(res.reserved_usdc)],
    ["lamports", big(res.reserved_lamports)],
    ["usage_units", big(res.reserved_usage_units)],
  ] as const) {
    if (amount === 0n) continue;
    appendFinancialEvent(ledger, {
      workspaceId: p.workspace_id,
      agentId: p.agent_id,
      taskId: p.task_id,
      purchaseId: p.id,
      kind,
      asset,
      amount,
      reason,
      occurredAtMs: now,
    });
  }
}

function recordExpense(
  ledger: Ledger,
  p: PurchaseRow,
  asset: "usdc" | "lamports" | "usage_units",
  principal: bigint,
  fee: bigint,
  settledAtMs: number,
): string {
  return appendFinancialEvent(ledger, {
    workspaceId: p.workspace_id,
    agentId: p.agent_id,
    taskId: p.task_id,
    purchaseId: p.id,
    kind: "expense_settled",
    asset,
    amount: checkedAdd(principal, fee),
    principalAmount: principal,
    feeAmount: fee,
    occurredAtMs: settledAtMs,
  });
}

/** Sets the settlement timestamp once; later calls keep the original value. */
function setSettledAt(ledger: Ledger, purchaseId: string, settledAtMs: number): void {
  ledger.db.prepare(`UPDATE purchase SET settled_at_ms = ? WHERE id = ? AND settled_at_ms IS NULL`).run(settledAtMs, purchaseId);
}

const UNRELEASED: readonly AuthorizationState[] = ["proposed", "awaiting_approval", "reserved"];

/** Cancels an operation whose authority was never released: reservation and note are freed. */
export function cancelUnreleased(ledger: Ledger, p: PurchaseRow, reason: "rejected" | "authority_stopped"): void {
  if (!UNRELEASED.includes(p.authorization_state)) return;
  transition(ledger, p.id, "authorization", p.authorization_state, "rejected", reason);
  if (p.funding_state === "not_started" || p.funding_state === "proof_prepared") {
    transition(ledger, p.id, "funding", p.funding_state, "abandoned");
  }
  if (p.merchant_state === "not_started") transition(ledger, p.id, "merchant", "not_started", "abandoned");
  if (p.fulfilment_state === "not_started") transition(ledger, p.id, "fulfilment", "not_started", "abandoned");
  closeReservation(ledger, p, "released", reason);
  unreserveNote(ledger, p.id);
  enqueueOutbox(ledger, "purchase.cancelled", p.id, { purchaseId: p.id, operationId: p.operation_id, reason });
}

/** Owner decision on a purchase awaiting approval. */
export function decidePurchase(ledger: Ledger, purchaseId: string, decision: "approve" | "reject", ownerId: string): PurchaseRow {
  return immediate(ledger.db, () => {
    const p = getPurchaseRow(ledger, purchaseId);
    if (p.authorization_state !== "awaiting_approval") {
      throw new ControlError("IDEMPOTENCY_CONFLICT", `purchase is ${p.authorization_state}, not awaiting approval`);
    }
    if (decision === "approve") {
      assertAuthorityCurrent(ledger, p);
      transition(ledger, p.id, "authorization", "awaiting_approval", "reserved", "owner_approved");
    } else {
      cancelUnreleased(ledger, p, "rejected");
    }
    writeAudit(ledger, {
      workspaceId: p.workspace_id,
      scope: `purchase:${p.id}`,
      actorType: "owner",
      actorId: ownerId,
      action: `purchase.${decision}`,
      policyResult: decision === "approve" ? "allowed" : "denied",
    });
    return getPurchaseRow(ledger, p.id);
  });
}

/**
 * Serialized authority boundary: the purchase may proceed only if the workspace is not stopped,
 * the agent is active, and neither the stop epoch nor the agent revocation epoch has moved since
 * authorization. Callers run this in the same transaction as the step it gates.
 */
export function assertAuthorityCurrent(ledger: Ledger, p: PurchaseRow): void {
  const ws = ledger.db.prepare(`SELECT * FROM workspace WHERE id = ?`).get(p.workspace_id) as WorkspaceRow;
  const agent = ledger.db.prepare(`SELECT * FROM agent WHERE id = ?`).get(p.agent_id) as AgentRow;
  if (ws.stopped === 1n || ws.emergency_stop_epoch !== p.stop_epoch) {
    throw new ControlError("ACCOUNT_STOPPED", "workspace emergency stop changed after authorization");
  }
  if (agent.status !== "active" || agent.revocation_epoch !== p.agent_epoch) {
    throw new ControlError("ACCOUNT_STOPPED", "agent authority was paused or revoked after authorization");
  }
}

export type AuthorityStage = "prepare_proof" | "release_proof" | "submit_withdrawal" | "sign_merchant" | "issue_usage_permit";

/**
 * Advances a purchase across one authority-releasing boundary after rechecking authority.
 * Material already released before a pause is not recalled; it stays visible as live exposure.
 */
export function advanceAuthority(ledger: Ledger, purchaseId: string, stage: AuthorityStage): PurchaseRow {
  return immediate(ledger.db, () => {
    const p = getPurchaseRow(ledger, purchaseId);
    assertAuthorityCurrent(ledger, p);
    switch (stage) {
      case "prepare_proof":
        requireState(p.authorization_state === "reserved" && p.funding_state === "not_started", "prepare_proof");
        transition(ledger, p.id, "funding", "not_started", "proof_prepared");
        break;
      case "release_proof":
        requireState(p.authorization_state === "reserved" && p.funding_state === "proof_prepared", "release_proof");
        transition(ledger, p.id, "authorization", "reserved", "released");
        transition(ledger, p.id, "funding", "proof_prepared", "proof_released");
        break;
      case "submit_withdrawal":
        requireState(p.funding_state === "proof_released", "submit_withdrawal");
        transition(ledger, p.id, "funding", "proof_released", "submitted");
        break;
      case "sign_merchant":
        requireState(p.funding_state === "finalized" && p.merchant_state === "not_started", "sign_merchant");
        transition(ledger, p.id, "merchant", "not_started", "signed");
        break;
      case "issue_usage_permit":
        requireState(p.payment_path === "prepaid_credits" && p.authorization_state === "reserved", "issue_usage_permit");
        transition(ledger, p.id, "authorization", "reserved", "released");
        break;
    }
    enqueueOutbox(ledger, `purchase.${stage}`, p.id, { purchaseId: p.id, operationId: p.operation_id });
    return getPurchaseRow(ledger, p.id);
  });
}

function requireState(ok: boolean, stage: string): void {
  if (!ok) throw new ControlError("IDEMPOTENCY_CONFLICT", `purchase is not in a state that permits ${stage}`);
}

/** Records the finalized funding withdrawal (service-observed chain evidence). */
export function recordFundingFinalized(ledger: Ledger, purchaseId: string, outcome: WithdrawalOutcome): PurchaseRow {
  return immediate(ledger.db, () => {
    const p = getPurchaseRow(ledger, purchaseId);
    if (p.funding_state === "finalized") return p;
    if (!["proof_released", "submitted", "uncertain"].includes(p.funding_state)) {
      throw new ControlError("IDEMPOTENCY_CONFLICT", "funding was not released");
    }
    if (outcome.payout !== big(p.price_usdc)) throw new ControlError("PRICE_CHANGED", "funded payout differs from the authorized price");
    if (outcome.tokenFees > big(p.fee_cap_usdc)) throw new ControlError("BUDGET_EXCEEDED", "token fees exceed the authorized cap");
    consumeReservedNote(ledger, p.id, outcome);
    transition(ledger, p.id, "funding", p.funding_state, "finalized");
    return getPurchaseRow(ledger, p.id);
  });
}

/** Marks a leg's outcome unknown; it stays live exposure until evidence resolves it. */
export function markUncertain(ledger: Ledger, purchaseId: string, field: "funding" | "merchant" | "fulfilment"): PurchaseRow {
  return immediate(ledger.db, () => {
    const p = getPurchaseRow(ledger, purchaseId);
    const from = p[COLUMN[field] as "funding_state" | "merchant_state" | "fulfilment_state"];
    if (from !== "uncertain") transition(ledger, p.id, field, from, "uncertain");
    return getPurchaseRow(ledger, p.id);
  });
}

export interface MerchantSettlement {
  merchantAmount: bigint;
  tokenFees: bigint;
  sponsorLamports: bigint;
  /** Finalized settlement time as observed by the service; recorded once. */
  settledAtMs: number;
}

/** Replaces the reservation with actual costs once the merchant leg is finalized. */
export function recordMerchantFinalized(ledger: Ledger, purchaseId: string, s: MerchantSettlement): PurchaseRow {
  return immediate(ledger.db, () => {
    const p = getPurchaseRow(ledger, purchaseId);
    if (p.merchant_state === "finalized") return p;
    if (!["signed", "submitted", "uncertain"].includes(p.merchant_state)) {
      throw new ControlError("IDEMPOTENCY_CONFLICT", "merchant leg was not signed");
    }
    const res = reservationFor(ledger, p.id);
    if (checkedAdd(s.merchantAmount, s.tokenFees) > big(res.reserved_usdc)) {
      throw new ControlError("RECOVERY_REQUIRED", "settled cost exceeds the reservation");
    }
    if (s.sponsorLamports > big(res.reserved_lamports)) {
      throw new ControlError("RECOVERY_REQUIRED", "sponsor cost exceeds the reservation");
    }
    transition(ledger, p.id, "merchant", p.merchant_state, "finalized");
    appendTokenEvent(ledger, {
      workspaceId: p.workspace_id,
      noteId: null,
      purchaseId: p.id,
      from: "payout_balance",
      to: "merchant_outflow",
      amount: s.merchantAmount,
      reason: "merchant_settled",
      occurredAtMs: s.settledAtMs,
    });
    setSettledAt(ledger, p.id, s.settledAtMs);
    recordExpense(ledger, p, "usdc", s.merchantAmount, s.tokenFees, s.settledAtMs);
    if (s.sponsorLamports > 0n) recordExpense(ledger, p, "lamports", 0n, s.sponsorLamports, s.settledAtMs);
    closeReservation(ledger, p, "settled", "settled");
    enqueueOutbox(ledger, "purchase.settled", p.id, { purchaseId: p.id, operationId: p.operation_id });
    return getPurchaseRow(ledger, p.id);
  });
}

/** Prepaid usage consumed once by the gateway: deducts usage allowance, never USDC. */
export function recordUsageConsumed(ledger: Ledger, purchaseId: string, units: bigint, settledAtMs: number): PurchaseRow {
  return immediate(ledger.db, () => {
    const p = getPurchaseRow(ledger, purchaseId);
    if (p.payment_path !== "prepaid_credits") throw new ControlError("IDEMPOTENCY_CONFLICT", "purchase is not a prepaid usage");
    if (p.fulfilment_state === "delivered") return p;
    if (units > big(p.usage_units)) throw new ControlError("RECOVERY_REQUIRED", "consumed units exceed the reservation");
    if (p.fulfilment_state === "not_started") transition(ledger, p.id, "fulfilment", "not_started", "in_progress");
    const current = getPurchaseRow(ledger, p.id);
    transition(ledger, p.id, "fulfilment", current.fulfilment_state, "delivered");
    setSettledAt(ledger, p.id, settledAtMs);
    recordExpense(ledger, p, "usage_units", units, 0n, settledAtMs);
    closeReservation(ledger, p, "settled", "settled");
    return getPurchaseRow(ledger, p.id);
  });
}

/** Proven pre-dispatch failure of a released usage permit: allowance is released. */
export function recordUsagePreDispatchFailure(ledger: Ledger, purchaseId: string): PurchaseRow {
  return immediate(ledger.db, () => {
    const p = getPurchaseRow(ledger, purchaseId);
    if (p.payment_path !== "prepaid_credits" || p.fulfilment_state !== "not_started") {
      throw new ControlError("SETTLEMENT_UNCERTAIN", "usage was dispatched; reconcile instead of releasing");
    }
    transition(ledger, p.id, "fulfilment", "not_started", "abandoned");
    closeReservation(ledger, p, "released", "pre_dispatch_failure");
    return getPurchaseRow(ledger, p.id);
  });
}

/**
 * A merchant refund after settlement: a linked adjustment restoring at most the settled
 * principal. Fees are never restored, and no negative expense is written.
 */
export function recordMerchantRefund(ledger: Ledger, purchaseId: string, amount: bigint, observedAtMs: number): void {
  immediate(ledger.db, () => {
    const p = getPurchaseRow(ledger, purchaseId);
    const expense = ledger.db
      .prepare(`SELECT event_id, principal_amount FROM financial_event WHERE purchase_id = ? AND kind = 'expense_settled' AND asset = 'usdc'`)
      .get(p.id) as { event_id: string; principal_amount: bigint } | undefined;
    if (!expense) throw new ControlError("RECOVERY_REQUIRED", "purchase has no settled expense to refund");
    appendFinancialEvent(ledger, {
      workspaceId: p.workspace_id,
      agentId: p.agent_id,
      taskId: p.task_id,
      purchaseId: p.id,
      kind: "expense_adjusted",
      asset: "usdc",
      amount,
      linkedEventId: expense.event_id,
      reason: "merchant_refund",
      occurredAtMs: observedAtMs,
    });
    appendTokenEvent(ledger, {
      workspaceId: p.workspace_id,
      noteId: null,
      purchaseId: p.id,
      from: "merchant_outflow",
      to: "payout_balance",
      amount,
      reason: "merchant_refund",
      occurredAtMs: observedAtMs,
    });
  });
}

/** Funded fresh wallet whose merchant leg cannot proceed becomes recoverable by the owner. */
export function markRecoverable(ledger: Ledger, purchaseId: string, reason: string): PurchaseRow {
  return immediate(ledger.db, () => {
    const p = getPurchaseRow(ledger, purchaseId);
    if (p.recovery_state !== "none") return p;
    if (p.funding_state !== "finalized") throw new ControlError("SETTLEMENT_UNCERTAIN", "funding is not finalized");
    if (p.merchant_state === "not_started") transition(ledger, p.id, "merchant", "not_started", "abandoned");
    const merchant = getPurchaseRow(ledger, p.id).merchant_state;
    if (!["abandoned", "expired_unsettled", "finalized"].includes(merchant)) {
      throw new ControlError("SETTLEMENT_UNCERTAIN", "merchant signature may still settle; wait for a proven outcome");
    }
    transition(ledger, p.id, "recovery", "none", "recoverable", reason);
    return getPurchaseRow(ledger, p.id);
  });
}

export interface ExternalRecovery {
  recoveredPrincipal: bigint;
  /** Token fees already paid on the funding withdrawal; they stay spent. */
  tokenFeesPaid: bigint;
  sponsorLamportsSpent: bigint;
  observedAtMs: number;
}

/**
 * Funds recovered from a fresh wallet to the owner's external account. This creates no pool
 * note (returning to private spending needs a new deposit). Unpaid principal leaves the
 * reservation; only fees already paid remain counted as expense.
 */
export function recordExternalRecovery(ledger: Ledger, purchaseId: string, r: ExternalRecovery): PurchaseRow {
  return immediate(ledger.db, () => {
    const p = getPurchaseRow(ledger, purchaseId);
    if (p.recovery_state === "recovered") return p;
    if (p.recovery_state === "recoverable") transition(ledger, p.id, "recovery", "recoverable", "recovery_submitted");
    const current = getPurchaseRow(ledger, p.id);
    if (current.recovery_state !== "recovery_submitted" && current.recovery_state !== "uncertain") {
      throw new ControlError("RECOVERY_REQUIRED", "purchase is not recoverable");
    }
    transition(ledger, p.id, "recovery", current.recovery_state, "recovered");
    appendTokenEvent(ledger, {
      workspaceId: p.workspace_id,
      noteId: null,
      purchaseId: p.id,
      from: "payout_balance",
      to: "external_recovered",
      amount: r.recoveredPrincipal,
      reason: "owner_recovery",
      occurredAtMs: r.observedAtMs,
    });
    const res = reservationFor(ledger, p.id);
    if (res.status === "active") {
      if (checkedAdd(r.tokenFeesPaid, r.recoveredPrincipal) > big(res.reserved_usdc)) {
        throw new ControlError("RECOVERY_REQUIRED", "recovered amount exceeds the reservation");
      }
      setSettledAt(ledger, p.id, r.observedAtMs);
      recordExpense(ledger, p, "usdc", 0n, r.tokenFeesPaid, r.observedAtMs);
      if (r.sponsorLamportsSpent > 0n) recordExpense(ledger, p, "lamports", 0n, r.sponsorLamportsSpent, r.observedAtMs);
      closeReservation(ledger, p, "released", "recovered");
    }
    enqueueOutbox(ledger, "purchase.recovered", p.id, { purchaseId: p.id, operationId: p.operation_id });
    return getPurchaseRow(ledger, p.id);
  });
}

/** Funding proof proven unusable (bound passed, nullifier unused, no settled withdrawal). */
export function recordFundingExpiredUnsettled(ledger: Ledger, purchaseId: string): PurchaseRow {
  return immediate(ledger.db, () => {
    const p = getPurchaseRow(ledger, purchaseId);
    if (p.funding_state === "expired_unsettled") return p;
    if (!["proof_released", "submitted", "uncertain"].includes(p.funding_state)) {
      throw new ControlError("IDEMPOTENCY_CONFLICT", "funding is not in flight");
    }
    transition(ledger, p.id, "funding", p.funding_state, "expired_unsettled");
    if (p.merchant_state === "not_started") transition(ledger, p.id, "merchant", "not_started", "abandoned");
    if (p.fulfilment_state === "not_started") transition(ledger, p.id, "fulfilment", "not_started", "abandoned");
    closeReservation(ledger, p, "released", "proven_unsettled");
    unreserveNote(ledger, p.id);
    return getPurchaseRow(ledger, p.id);
  });
}

/** Cancels unreleased operations for an agent (or all agents) when authority stops. */
export function cancelUnreleasedFor(ledger: Ledger, workspaceId: string, agentId: string | null): number {
  const rows = ledger.db
    .prepare(
      `SELECT * FROM purchase WHERE workspace_id = ? AND (? IS NULL OR agent_id = ?)
       AND authorization_state IN ('proposed', 'awaiting_approval', 'reserved')`,
    )
    .all(workspaceId, agentId, agentId) as PurchaseRow[];
  for (const p of rows) cancelUnreleased(ledger, p, "authority_stopped");
  return rows.length;
}

export function purchaseView(ledger: Ledger, p: PurchaseRow): Record<string, unknown> {
  const res = reservationFor(ledger, p.id);
  const states = {
    authorization: p.authorization_state,
    funding: p.funding_state,
    merchant: p.merchant_state,
    fulfilment: p.fulfilment_state,
    recovery: p.recovery_state,
  };
  const attempts = ledger.db
    .prepare(`SELECT leg, attempt_no, signature, observed_commitment FROM chain_attempt WHERE purchase_id = ? ORDER BY leg, attempt_no`)
    .all(p.id) as Array<{ leg: string; attempt_no: bigint; signature: string | null; observed_commitment: string }>;
  return {
    id: p.id,
    operationId: p.operation_id,
    agentId: p.agent_id,
    taskId: p.task_id,
    serviceId: p.service_id,
    sku: p.sku,
    paymentPath: p.payment_path,
    requestDigest: p.request_digest,
    price: { amount: big(p.price_usdc).toString(), unit: "usdc_base_units" },
    feeCap: { amount: big(p.fee_cap_usdc).toString(), unit: "usdc_base_units" },
    sponsorReservation: { amount: big(p.sponsor_lamports).toString(), unit: "lamports" },
    usage: { amount: big(p.usage_units).toString(), unit: "gateway_microcredits" },
    states,
    label: paymentStatusLabel(states),
    stateReason: p.state_reason,
    reservation: {
      status: res.status,
      closeReason: res.close_reason,
      usdc: big(res.reserved_usdc).toString(),
      lamports: big(res.reserved_lamports).toString(),
      usageUnits: big(res.reserved_usage_units).toString(),
    },
    policyVersions: { workspace: num(p.workspace_policy_version), agent: num(p.agent_policy_version) },
    epochs: { agent: num(p.agent_epoch), stop: num(p.stop_epoch) },
    chainAttempts: attempts.map((a) => ({
      leg: a.leg,
      attempt: num(a.attempt_no),
      signature: a.signature,
      commitment: a.observed_commitment,
    })),
    rationale: p.rationale,
    settledAt: optIso(p.settled_at_ms),
    createdAt: iso(p.created_at_ms),
    updatedAt: iso(p.updated_at_ms),
  };
}
