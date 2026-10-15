import { randomUUID } from "node:crypto";
import type { GatewayDb } from "../db/database";
import { GatewayError } from "../errors";

export type OperatorPurpose = "x402" | "prepaid" | "planning" | "smoke";

/**
 * Real-dollar exposure: open and uncertain reservations at worst case, settled calls at
 * their recorded actual cost (worst case when the provider reported none).
 */
export function operatorExposureMicro(db: GatewayDb): bigint {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE
          WHEN state IN ('reserved', 'uncertain') THEN worst_case_micro
          WHEN state = 'settled' THEN COALESCE(actual_micro, worst_case_micro)
          ELSE 0 END), 0) AS exposure FROM operator_cost_ledger`,
    )
    .get() as { exposure: bigint };
  return row.exposure;
}

/** Must run inside the caller's immediate transaction, before the provider request. */
export function reserveOperatorCost(
  db: GatewayDb,
  entry: { executionId: string; model: string; purpose: OperatorPurpose; worstCaseMicro: bigint; ceilingMicro: bigint; at: Date },
): string {
  const exposure = operatorExposureMicro(db);
  if (entry.worstCaseMicro <= 0n || exposure + entry.worstCaseMicro > entry.ceilingMicro) {
    throw new GatewayError(503, "OPERATOR_BUDGET_EXHAUSTED", "Operator inference allowance exhausted");
  }
  const id = `opc_${randomUUID()}`;
  db.prepare(
    "INSERT INTO operator_cost_ledger (id, execution_id, model, purpose, worst_case_micro, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)",
  ).run(id, entry.executionId, entry.model, entry.purpose, entry.worstCaseMicro, entry.at.toISOString(), entry.at.toISOString());
  return id;
}

export function resolveOperatorCost(
  db: GatewayDb,
  executionId: string,
  outcome: { state: "settled"; actualMicro: bigint | null; source: string } | { state: "released" } | { state: "uncertain" },
  at: Date,
): void {
  const result = db
    .prepare(
      "UPDATE operator_cost_ledger SET state = ?, actual_micro = ?, actual_source = ?, updated_at = ? WHERE execution_id = ? AND state IN ('reserved', 'uncertain')",
    )
    .run(
      outcome.state,
      outcome.state === "settled" ? outcome.actualMicro : null,
      outcome.state === "settled" ? outcome.source : null,
      at.toISOString(),
      executionId,
    );
  if (result.changes !== 1) throw new Error("operator cost entry is not open");
}

export interface OperatorBudgetView {
  ceilingMicro: string;
  exposureMicro: string;
  remainingMicro: string;
  settledActualMicro: string;
  openReservations: number;
  uncertain: number;
}

export function operatorBudgetView(db: GatewayDb, ceilingMicro: bigint): OperatorBudgetView {
  const exposure = operatorExposureMicro(db);
  const counts = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN state = 'settled' THEN COALESCE(actual_micro, worst_case_micro) ELSE 0 END), 0) AS settled,
         COALESCE(SUM(state = 'reserved'), 0) AS open,
         COALESCE(SUM(state = 'uncertain'), 0) AS uncertain
       FROM operator_cost_ledger`,
    )
    .get() as { settled: bigint; open: bigint; uncertain: bigint };
  return {
    ceilingMicro: ceilingMicro.toString(),
    exposureMicro: exposure.toString(),
    remainingMicro: (exposure >= ceilingMicro ? 0n : ceilingMicro - exposure).toString(),
    settledActualMicro: counts.settled.toString(),
    openReservations: Number(counts.open),
    uncertain: Number(counts.uncertain),
  };
}
