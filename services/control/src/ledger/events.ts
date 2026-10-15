import { createHash } from "node:crypto";
import type { Ledger } from "../context";

export type ActorType = "owner" | "worker" | "service" | "system";

export interface AuditInput {
  workspaceId: string | null;
  scope: string;
  actorType: ActorType;
  actorId: string | null;
  action: string;
  policyResult: "allowed" | "denied" | "not_applicable";
  reasonCode?: string | null;
  details?: Record<string, unknown>;
}

// Keys whose values must never be persisted in audit rows or outbox payloads.
const SECRET_KEY = /secret|seed|private|password|passphrase|token|cookie|credential|csrf|authorization|ciphertext|mnemonic|keypair|api_?key/i;
const BEARER_LIKE = /(vwk_|vos_)[A-Za-z0-9_-]+/g;

/** Redacts bearer-shaped substrings from free text supplied by workers or callers. */
export function redactText(value: string): string {
  return value.replace(BEARER_LIKE, "[redacted]");
}

/** Removes secret-looking keys and bearer-shaped values; bounds string size and depth. */
export function sanitizeDetails(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    const clean = redactText(value);
    return clean.length > 500 ? `${clean.slice(0, 500)}…` : clean;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeDetails(v, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? "[redacted]" : sanitizeDetails(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function writeAudit(ledger: Ledger, input: AuditInput): void {
  ledger.db
    .prepare(
      `INSERT INTO audit_event (event_id, workspace_id, scope, actor_type, actor_id, action, policy_result,
         reason_code, details_json, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ledger.newId(),
      input.workspaceId,
      input.scope,
      input.actorType,
      input.actorId,
      input.action,
      input.policyResult,
      input.reasonCode ?? null,
      JSON.stringify(sanitizeDetails(input.details ?? {})),
      ledger.now(),
    );
}

/** Must run inside the transaction that produced the state change it announces. */
export function enqueueOutbox(ledger: Ledger, topic: string, aggregateId: string, payload: Record<string, unknown>): string {
  const eventId = ledger.newId();
  ledger.db
    .prepare(
      `INSERT INTO outbox (event_id, topic, aggregate_id, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(eventId, topic, aggregateId, JSON.stringify(sanitizeDetails(payload)), ledger.now());
  return eventId;
}

export interface OutboxRow {
  seq: bigint;
  event_id: string;
  topic: string;
  aggregate_id: string;
  payload_json: string;
}

export function pendingOutbox(ledger: Ledger, limit = 100): OutboxRow[] {
  return ledger.db
    .prepare(`SELECT seq, event_id, topic, aggregate_id, payload_json FROM outbox WHERE published_at_ms IS NULL ORDER BY seq LIMIT ?`)
    .all(limit) as OutboxRow[];
}

export function markOutboxPublished(ledger: Ledger, eventId: string): boolean {
  const r = ledger.db
    .prepare(`UPDATE outbox SET published_at_ms = ?, attempts = attempts + 1 WHERE event_id = ? AND published_at_ms IS NULL`)
    .run(ledger.now(), eventId);
  return r.changes === 1;
}

/**
 * Records an inbound cross-service event exactly once. Returns false for a duplicate delivery
 * with the same payload; a reused event ID with a different payload is an error.
 */
export function acceptInbox(ledger: Ledger, source: string, eventId: string, topic: string, payload: unknown): boolean {
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const existing = ledger.db.prepare(`SELECT payload_digest FROM inbox WHERE event_id = ?`).pluck().get(eventId) as
    | string
    | undefined;
  if (existing !== undefined) {
    if (existing !== digest) throw new Error("inbox event ID reused with a different payload");
    return false;
  }
  ledger.db
    .prepare(`INSERT INTO inbox (event_id, source, topic, payload_digest, received_at_ms) VALUES (?, ?, ?, ?, ?)`)
    .run(eventId, source, topic, digest, ledger.now());
  return true;
}

export function markInboxProcessed(ledger: Ledger, eventId: string): void {
  ledger.db.prepare(`UPDATE inbox SET processed_at_ms = ? WHERE event_id = ? AND processed_at_ms IS NULL`).run(ledger.now(), eventId);
}

export interface FinancialEventInput {
  workspaceId: string;
  agentId: string | null;
  taskId: string | null;
  purchaseId: string | null;
  kind: "reservation_opened" | "reservation_released" | "reservation_settled" | "expense_settled" | "expense_adjusted";
  asset: "usdc" | "lamports" | "usage_units";
  amount: bigint;
  principalAmount?: bigint;
  feeAmount?: bigint;
  linkedEventId?: string;
  reason?: string;
  occurredAtMs: number;
}

export function appendFinancialEvent(ledger: Ledger, e: FinancialEventInput): string {
  const eventId = ledger.newId();
  ledger.db
    .prepare(
      `INSERT INTO financial_event (event_id, workspace_id, agent_id, task_id, purchase_id, kind, asset, amount,
         principal_amount, fee_amount, linked_event_id, reason, occurred_at_ms, recorded_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      eventId,
      e.workspaceId,
      e.agentId,
      e.taskId,
      e.purchaseId,
      e.kind,
      e.asset,
      e.amount,
      e.principalAmount ?? null,
      e.feeAmount ?? null,
      e.linkedEventId ?? null,
      e.reason ?? null,
      e.occurredAtMs,
      ledger.now(),
    );
  return eventId;
}
