import type { Balances, LimitUsage, Purchase } from "./types";

const isBase = (v: string | null | undefined): v is string => typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v);
const big = (v: string | null | undefined): bigint => (isBase(v) ? BigInt(v) : 0n);

/** Only a finalized merchant leg on the private x402 path moved USDC; anything else is not counted as spent. */
export function paidOnChain(p: Pick<Purchase, "paymentPath" | "states">): boolean {
  return p.paymentPath === "private_x402" && p.states.merchant === "finalized";
}

export interface DaySpend {
  /** Local midnight that starts the day. */
  start: Date;
  /** Base units paid that day. */
  total: bigint;
  count: number;
}

export interface SpendSeries {
  days: DaySpend[];
  /** False when the fetched page of payments may not reach back to the first day shown. */
  complete: boolean;
}

/**
 * Settled USDC payments per local calendar day, oldest first, ending today. `fetchedLimit` is the
 * page size the payments came from: a full page that ends inside the window may be missing older days.
 */
export function dailySpend(purchases: Purchase[], now: Date, days = 7, fetchedLimit?: number): SpendSeries {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const out: DaySpend[] = [];
  for (let i = days - 1; i >= 0; i--) out.push({ start: new Date(today.getFullYear(), today.getMonth(), today.getDate() - i), total: 0n, count: 0 });
  const first = out[0]!.start.getTime();
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime();
  for (const p of purchases) {
    if (!paidOnChain(p)) continue;
    const at = Date.parse(p.settledAt ?? p.updatedAt ?? p.createdAt);
    if (Number.isNaN(at) || at < first || at >= end) continue;
    // Boundaries are local midnights, so a DST change never moves a payment into the wrong day.
    const idx = out.findLastIndex((d) => at >= d.start.getTime());
    out[idx]!.total += big(p.price.amount);
    out[idx]!.count += 1;
  }
  const oldest = purchases.reduce<number>((min, p) => Math.min(min, Date.parse(p.createdAt) || min), Number.POSITIVE_INFINITY);
  const complete = fetchedLimit === undefined || purchases.length < fetchedLimit || oldest < first;
  return { days: out, complete };
}

export interface TreasuryParts {
  ready: string;
  held: string;
  pending: string;
  /** Funded one-time payment wallets; outside the pool. */
  outside: string;
}

/** Splits the owner's pool buckets by readiness; null in the public view, where buckets are withheld. */
export function treasuryParts(balances: Balances): TreasuryParts | null {
  const b = balances.tokens.buckets;
  if (!b) return null;
  return {
    ready: (big(b.approved_unreserved) + big(b.confirmed_change)).toString(),
    held: big(b.reserved_input).toString(),
    pending: big(b.pending_change).toString(),
    outside: big(b.payout_balance).toString(),
  };
}

/** Settled plus reserved spend against a limit. */
export const usedOf = (u: LimitUsage): string => (big(u.settled) + big(u.reserved)).toString();

/** Share of `part` in `whole` as a 0–100 number for drawing only; amounts stay exact strings. */
export function percent(part: string | bigint, whole: string | bigint): number {
  const p = typeof part === "bigint" ? part : big(part);
  const w = typeof whole === "bigint" ? whole : big(whole);
  if (w <= 0n || p <= 0n) return 0;
  if (p >= w) return 100;
  return Number((p * 10_000n) / w) / 100;
}
