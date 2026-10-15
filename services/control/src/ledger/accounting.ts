import { checkedAdd, checkedSub, headroom } from "@veilo/contracts";
import { DAY_MS, big, type Ledger } from "../context";

export type Asset = "usdc" | "lamports" | "usage_units";
export type Scope = { kind: "workspace"; id: string } | { kind: "agent"; id: string } | { kind: "task"; id: string };

const SCOPE_COLUMN = { workspace: "workspace_id", agent: "agent_id", task: "task_id" } as const;
const RESERVATION_COLUMN = { usdc: "reserved_usdc", lamports: "reserved_lamports", usage_units: "reserved_usage_units" } as const;

/** Sum of live reservations regardless of age; unresolved attempts never age out of a cap. */
export function activeReserved(ledger: Ledger, scope: Scope, asset: Asset): bigint {
  const sql = `SELECT ifnull(sum(${RESERVATION_COLUMN[asset]}), 0) FROM reservation
               WHERE status = 'active' AND ${SCOPE_COLUMN[scope.kind]} = ?`;
  return big(ledger.db.prepare(sql).pluck().get(scope.id));
}

/** Unrecovered expenditure: settled costs minus linked refund/recovery adjustments, at any time. */
export function settledLifetime(ledger: Ledger, scope: Scope, asset: Asset): bigint {
  const col = SCOPE_COLUMN[scope.kind];
  const expenses = big(
    ledger.db
      .prepare(`SELECT ifnull(sum(amount), 0) FROM financial_event WHERE kind = 'expense_settled' AND asset = ? AND ${col} = ?`)
      .pluck()
      .get(asset, scope.id),
  );
  const restored = big(
    ledger.db
      .prepare(`SELECT ifnull(sum(amount), 0) FROM financial_event WHERE kind = 'expense_adjusted' AND asset = ? AND ${col} = ?`)
      .pluck()
      .get(asset, scope.id),
  );
  return checkedSub(expenses, restored);
}

/**
 * Settled cost inside the trailing 24 hours. An adjustment offsets only its own linked expense,
 * and only while that expense's immutable settlement time is still inside the window.
 */
export function settledRolling(ledger: Ledger, scope: Scope, asset: Asset, nowMs: number): bigint {
  const col = SCOPE_COLUMN[scope.kind];
  const windowStart = nowMs - DAY_MS;
  const expenses = big(
    ledger.db
      .prepare(
        `SELECT ifnull(sum(amount), 0) FROM financial_event
         WHERE kind = 'expense_settled' AND asset = ? AND ${col} = ? AND occurred_at_ms > ?`,
      )
      .pluck()
      .get(asset, scope.id, windowStart),
  );
  const restored = big(
    ledger.db
      .prepare(
        `SELECT ifnull(sum(a.amount), 0) FROM financial_event a
         JOIN financial_event e ON e.event_id = a.linked_event_id
         WHERE a.kind = 'expense_adjusted' AND a.asset = ? AND e.${col} = ? AND e.occurred_at_ms > ?`,
      )
      .pluck()
      .get(asset, scope.id, windowStart),
  );
  return checkedSub(expenses, restored);
}

export interface LimitUsage {
  limit: bigint;
  settled: bigint;
  reserved: bigint;
  /** limit - settled - reserved, floored at zero. */
  available: bigint;
  /** Exposure beyond the limit after an owner lowered it; zero when within the limit. */
  overCommitted: bigint;
}

function usage(limit: bigint, settled: bigint, reserved: bigint): LimitUsage {
  const used = checkedAdd(settled, reserved);
  return {
    limit,
    settled,
    reserved,
    available: headroom(limit, used),
    overCommitted: used > limit ? used - limit : 0n,
  };
}

export function lifetimeUsage(ledger: Ledger, scope: Scope, asset: Asset, limit: bigint): LimitUsage {
  return usage(limit, settledLifetime(ledger, scope, asset), activeReserved(ledger, scope, asset));
}

export function rollingUsage(ledger: Ledger, scope: Scope, asset: Asset, limit: bigint, nowMs: number): LimitUsage {
  return usage(limit, settledRolling(ledger, scope, asset, nowMs), activeReserved(ledger, scope, asset));
}

/** True when `amount` more exposure fits under the limit. */
export function fits(u: LimitUsage, amount: bigint): boolean {
  return checkedAdd(checkedAdd(u.settled, u.reserved), amount) <= u.limit;
}

export function serializeUsage(u: LimitUsage): Record<string, string> {
  return {
    limit: u.limit.toString(),
    settled: u.settled.toString(),
    reserved: u.reserved.toString(),
    available: u.available.toString(),
    overCommitted: u.overCommitted.toString(),
  };
}
