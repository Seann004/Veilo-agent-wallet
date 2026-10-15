import { z } from "zod";

/** Largest value storable in a SQLite INTEGER column; ledger amounts never exceed it. */
export const MAX_LEDGER_AMOUNT = (1n << 63n) - 1n;
/** Largest on-chain token amount (SPL Token u64). */
export const U64_MAX = (1n << 64n) - 1n;

export const AMOUNT_UNITS = ["usdc_base_units", "lamports", "gateway_microcredits"] as const;
export type AmountUnit = (typeof AMOUNT_UNITS)[number];

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountError";
  }
}

const DECIMAL_BASE_UNITS = /^(0|[1-9][0-9]*)$/;

/**
 * Parses a canonical non-negative decimal integer string. Numbers, floats, exponents,
 * signs, whitespace and leading zeros are rejected so one value has exactly one encoding.
 */
export function parseBaseUnits(value: unknown, max: bigint = MAX_LEDGER_AMOUNT): bigint {
  if (typeof value !== "string") throw new AmountError("amount must be a decimal string");
  if (value.length > 20 || !DECIMAL_BASE_UNITS.test(value)) {
    throw new AmountError("amount must be a canonical non-negative integer string");
  }
  const parsed = BigInt(value);
  if (parsed > max) throw new AmountError("amount exceeds the permitted maximum");
  return parsed;
}

export function formatBaseUnits(value: bigint): string {
  assertLedgerAmount(value);
  return value.toString(10);
}

export function assertLedgerAmount(value: bigint, max: bigint = MAX_LEDGER_AMOUNT): void {
  if (typeof value !== "bigint") throw new AmountError("amount must be a bigint");
  if (value < 0n) throw new AmountError("amount must not be negative");
  if (value > max) throw new AmountError("amount exceeds the permitted maximum");
}

export function checkedAdd(a: bigint, b: bigint, max: bigint = MAX_LEDGER_AMOUNT): bigint {
  assertLedgerAmount(a, max);
  assertLedgerAmount(b, max);
  const sum = a + b;
  if (sum > max) throw new AmountError("amount addition overflows");
  return sum;
}

/** Throws instead of producing a negative result. */
export function checkedSub(a: bigint, b: bigint, max: bigint = MAX_LEDGER_AMOUNT): bigint {
  assertLedgerAmount(a, max);
  assertLedgerAmount(b, max);
  if (b > a) throw new AmountError("amount subtraction underflows");
  return a - b;
}

export function checkedMul(a: bigint, b: bigint, max: bigint = MAX_LEDGER_AMOUNT): bigint {
  assertLedgerAmount(a, max);
  assertLedgerAmount(b, max);
  const product = a * b;
  if (product > max) throw new AmountError("amount multiplication overflows");
  return product;
}

export function checkedSum(values: readonly bigint[], max: bigint = MAX_LEDGER_AMOUNT): bigint {
  return values.reduce((acc, v) => checkedAdd(acc, v, max), 0n);
}

/** Remaining headroom, or zero when usage already meets or exceeds the limit. */
export function headroom(limit: bigint, used: bigint): bigint {
  assertLedgerAmount(limit);
  assertLedgerAmount(used);
  return used >= limit ? 0n : limit - used;
}

/** API wire format for base-unit amounts: a canonical decimal string. */
export const baseUnitString = z.string().refine(
  (v) => {
    try {
      parseBaseUnits(v);
      return true;
    } catch {
      return false;
    }
  },
  { message: "must be a canonical non-negative integer decimal string within ledger bounds" },
);

export const baseUnits = baseUnitString.transform((v) => BigInt(v));

export interface Money {
  amount: string;
  unit: AmountUnit;
}

export function money(amount: bigint, unit: AmountUnit): Money {
  return { amount: formatBaseUnits(amount), unit };
}
