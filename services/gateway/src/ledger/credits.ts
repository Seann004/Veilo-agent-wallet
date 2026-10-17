import { randomUUID } from "node:crypto";
import { GATEWAY_CREDIT_LABEL, type CreditBalanceView } from "@veilo/contracts/gateway";
import type { GatewayDb } from "../db/database";

type CreditEventKind = "issue" | "reserve" | "consume" | "release";

const COUNTER_DELTAS: Record<CreditEventKind, { issued: bigint; reserved: bigint; consumed: bigint }> = {
  issue: { issued: 1n, reserved: 0n, consumed: 0n },
  reserve: { issued: 0n, reserved: 1n, consumed: 0n },
  consume: { issued: 0n, reserved: -1n, consumed: 1n },
  release: { issued: 0n, reserved: -1n, consumed: 0n },
};

/**
 * Appends one immutable credit event and applies the same delta to the cached counters.
 * Must run inside the caller's immediate transaction. The account CHECK constraint makes a
 * negative usable balance impossible to commit.
 */
export function appendCreditEvent(
  db: GatewayDb,
  event: {
    accountId: string;
    kind: CreditEventKind;
    units: bigint;
    issuanceId?: string;
    reservationId?: string;
    at: Date;
  },
): void {
  if (event.units <= 0n) throw new Error("credit event units must be positive");
  db.prepare(
    "INSERT INTO credit_events (id, account_id, kind, units, issuance_id, reservation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    `cev_${randomUUID()}`,
    event.accountId,
    event.kind,
    event.units,
    event.issuanceId ?? null,
    event.reservationId ?? null,
    event.at.toISOString(),
  );
  const d = COUNTER_DELTAS[event.kind];
  db.prepare(
    "UPDATE accounts SET issued = issued + ?, reserved = reserved + ?, consumed = consumed + ?, version = version + 1 WHERE id = ?",
  ).run(d.issued * event.units, d.reserved * event.units, d.consumed * event.units, event.accountId);
}

export interface DerivedCounters {
  issued: bigint;
  reserved: bigint;
  consumed: bigint;
  events: bigint;
}

/** Recomputes counters from the event log alone. */
export function deriveCounters(db: GatewayDb, accountId: string): DerivedCounters {
  const rows = db
    .prepare("SELECT kind, SUM(units) AS total, COUNT(*) AS n FROM credit_events WHERE account_id = ? GROUP BY kind")
    .all(accountId) as Array<{ kind: CreditEventKind; total: bigint; n: bigint }>;
  const sum = (k: CreditEventKind) => rows.find((r) => r.kind === k)?.total ?? 0n;
  return {
    issued: sum("issue"),
    reserved: sum("reserve") - sum("consume") - sum("release"),
    consumed: sum("consume"),
    events: rows.reduce((acc, r) => acc + r.n, 0n),
  };
}

/** Throws if the cached counters disagree with the event log. */
export function verifyCounters(db: GatewayDb, accountId: string): void {
  const cached = db.prepare("SELECT issued, reserved, consumed, version FROM accounts WHERE id = ?").get(accountId) as
    | { issued: bigint; reserved: bigint; consumed: bigint; version: bigint }
    | undefined;
  if (!cached) throw new Error("account not found");
  const derived = deriveCounters(db, accountId);
  if (
    cached.issued !== derived.issued ||
    cached.reserved !== derived.reserved ||
    cached.consumed !== derived.consumed ||
    cached.version !== derived.events
  ) {
    throw new Error(`credit counters for ${accountId} disagree with the event log`);
  }
}

export function balanceView(db: GatewayDb, accountId: string, now: Date): CreditBalanceView {
  verifyCounters(db, accountId);
  const row = db.prepare("SELECT issued, reserved, consumed, version FROM accounts WHERE id = ?").get(accountId) as {
    issued: bigint;
    reserved: bigint;
    consumed: bigint;
    version: bigint;
  };
  return {
    accountId,
    issued: row.issued.toString(),
    reserved: row.reserved.toString(),
    consumed: row.consumed.toString(),
    usable: (row.issued - row.consumed - row.reserved).toString(),
    unit: "gateway_microcredits",
    version: row.version.toString(),
    asOf: now.toISOString(),
    label: GATEWAY_CREDIT_LABEL,
  };
}
