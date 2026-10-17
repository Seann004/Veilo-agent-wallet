import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

const STATUS: Record<string, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  POLICY_DENIED: 403,
  SERVICE_NOT_ALLOWED: 403,
  NOT_FOUND: 404,
  INVALID_REQUEST: 400,
  INVALID_TRANSITION: 409,
  IDEMPOTENCY_CONFLICT: 409,
  PRICE_CHANGED: 409,
  QUOTE_EXPIRED: 409,
  SETTLEMENT_UNCERTAIN: 409,
  LEASE_LOST: 409,
  WRONG_NETWORK: 409,
  WRONG_MINT: 409,
  ACCOUNT_STOPPED: 423,
  RATE_LIMITED: 429,
  NOT_READY: 503,
  PROVIDER_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export class MarketError extends Error {
  readonly status: number;
  constructor(
    readonly code: string,
    message: string,
    status?: number,
  ) {
    super(message);
    this.status = status ?? STATUS[code] ?? 400;
  }
}

/** Transition functions raise `CODE: message`; anything else is an internal failure. */
export function fromDbError(error: { message?: string; code?: string } | null): MarketError | null {
  if (!error) return null;
  const match = /^([A-Z_]+): (.*)$/s.exec(error.message ?? "");
  if (match && match[1] && STATUS[match[1]] !== undefined) return new MarketError(match[1], match[2] ?? "");
  return new MarketError("INTERNAL_ERROR", "database operation failed", 500);
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof MarketError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof ZodError) {
    res.status(400).json({ error: { code: "INVALID_REQUEST", message: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") } });
    return;
  }
  if (error instanceof SyntaxError) {
    res.status(400).json({ error: { code: "INVALID_REQUEST", message: "malformed JSON body" } });
    return;
  }
  console.error("[marketplace] unhandled error", error instanceof Error ? error.message : "unknown");
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "internal error" } });
}
