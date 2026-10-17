export type X402ClientErrorCode =
  | "SERVICE_NOT_ALLOWED"
  | "WRONG_NETWORK"
  | "WRONG_MINT"
  | "PRICE_CHANGED"
  | "POLICY_DENIED"
  | "PROVIDER_UNAVAILABLE"
  | "SETTLEMENT_UNCERTAIN";

/** Raised before any signature is produced when a requirement or transaction is not acceptable. */
export class X402ClientError extends Error {
  readonly code: X402ClientErrorCode;
  readonly reason: string;

  constructor(code: X402ClientErrorCode, reason: string, message?: string) {
    super(message ?? `${code}: ${reason}`);
    this.name = "X402ClientError";
    this.code = code;
    this.reason = reason;
  }
}
