import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "@veilo/db";

export interface Ledger {
  db: SqliteDatabase;
  /** Epoch milliseconds; injectable so window and expiry logic is testable. */
  now: () => number;
  newId: () => string;
}

export function createLedger(db: SqliteDatabase, now: () => number = Date.now): Ledger {
  return { db, now, newId: randomUUID };
}

export const DAY_MS = 86_400_000;

/** SQLite returns 64-bit integers as bigint on ledger connections. */
export const num = (v: unknown): number => {
  if (typeof v === "bigint") {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError("integer column exceeds safe number range");
    }
    return Number(v);
  }
  if (typeof v === "number" && Number.isInteger(v)) return v;
  throw new TypeError("expected an integer column value");
};

export const big = (v: unknown): bigint => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  throw new TypeError("expected an integer amount column");
};

export const optNum = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
export const iso = (ms: unknown): string => new Date(num(ms)).toISOString();
export const optIso = (ms: unknown): string | null => (ms === null || ms === undefined ? null : iso(ms));
