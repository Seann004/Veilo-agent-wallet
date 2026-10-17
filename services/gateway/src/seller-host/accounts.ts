import { randomUUID } from "node:crypto";
import { createAccount, type CreatedAccount } from "../auth";
import type { GatewayDb } from "../db/database";
import { GatewayError } from "../errors";

export interface AccountRateLimit {
  perIp: number;
  global: number;
  windowMs: number;
}

export const DEFAULT_ACCOUNT_RATE_LIMIT: AccountRateLimit = { perIp: 5, global: 200, windowMs: 60 * 60_000 };

/**
 * Fixed-window limits on self-service account creation, per client address and overall.
 * In-memory: a restart resets the windows, which only loosens the limit for one window.
 */
export class AccountRateLimiter {
  readonly #hits = new Map<string, { start: number; n: number }>();
  #global = { start: 0, n: 0 };

  constructor(
    private readonly limit: AccountRateLimit,
    private readonly now: () => Date,
  ) {}

  take(ip: string): boolean {
    const t = this.now().getTime();
    if (t - this.#global.start >= this.limit.windowMs) this.#global = { start: t, n: 0 };
    let entry = this.#hits.get(ip);
    if (!entry || t - entry.start >= this.limit.windowMs) {
      entry = { start: t, n: 0 };
      this.#hits.set(ip, entry);
    }
    if (entry.n >= this.limit.perIp || this.#global.n >= this.limit.global) return false;
    entry.n += 1;
    this.#global.n += 1;
    if (this.#hits.size > 10_000) {
      for (const [k, v] of this.#hits) if (t - v.start >= this.limit.windowMs) this.#hits.delete(k);
    }
    return true;
  }
}

/**
 * Buyer account on a seller host. The account only scopes its own quotes and results;
 * it carries no credits and authorizes no work without a separate valid payment.
 */
export function createBuyerAccount(db: GatewayDb, limiter: AccountRateLimiter, ip: string, now: Date): CreatedAccount {
  if (!limiter.take(ip)) throw new GatewayError(429, "POLICY_DENIED", "Too many accounts created; try again later");
  return createAccount(db, `buyer:${randomUUID()}`, "seller-host-buyer", now);
}
