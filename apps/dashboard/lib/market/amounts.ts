import { groupDigits } from "../format";

/** Mirrors the marketplace's base-unit wire format: a canonical nonnegative integer of at most 20 digits. */
const CANONICAL = /^(0|[1-9][0-9]{0,19})$/;

/**
 * Normalizes a base-unit amount from the API. PostgREST serializes numeric columns as JSON
 * numbers, so a number is accepted only while it is an exact safe integer; anything that may
 * already have lost precision is reported as unknown instead of being displayed.
 */
export function toBaseUnits(value: unknown): string | null {
  if (typeof value === "string") return CANONICAL.test(value) ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "bigint" && value >= 0n) return value.toString();
  return null;
}

/** Exact decimal rendering of base units; trailing fractional zeros are dropped, digits are grouped. */
export function formatUnits(amount: unknown, decimals: number): string | null {
  const v = toBaseUnits(amount);
  if (v === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
  const n = BigInt(v);
  const scale = 10n ** BigInt(decimals);
  const whole = groupDigits((n / scale).toString());
  if (decimals === 0) return whole;
  const frac = (n % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac === "" ? whole : `${whole}.${frac}`;
}

export type ParseResult = { ok: true; value: string } | { ok: false; error: string };

/**
 * Parses an owner-entered decimal ("1.25") into base units without floats. Rejects signs,
 * exponents, grouping separators and more fractional digits than the mint allows.
 */
export function parseUnits(text: string, decimals: number): ParseResult {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return { ok: false, error: "the token's decimals are unknown" };
  const t = text.trim();
  if (t === "") return { ok: false, error: "enter an amount" };
  const m = /^(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m || `${m[1]}${m[2] ?? ""}` === "") return { ok: false, error: "use digits and at most one decimal point" };
  const frac = m[2] ?? "";
  if (frac.length > decimals) {
    return { ok: false, error: decimals === 0 ? "this token has no decimal places" : `at most ${decimals} decimal places for this token` };
  }
  const value = (BigInt(m[1] || "0") * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0")).toString();
  if (!CANONICAL.test(value)) return { ok: false, error: "amount is too large" };
  return { ok: true, value };
}

export function sumUnits(values: unknown[]): string | null {
  let total = 0n;
  for (const v of values) {
    const b = toBaseUnits(v);
    if (b === null) return null;
    total += BigInt(b);
  }
  return total.toString();
}
