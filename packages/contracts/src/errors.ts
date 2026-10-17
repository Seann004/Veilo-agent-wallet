export const ERROR_CODES = [
  "POLICY_DENIED",
  "BUDGET_EXCEEDED",
  "SERVICE_NOT_ALLOWED",
  "PRICE_CHANGED",
  "WRONG_NETWORK",
  "WRONG_MINT",
  "ACCOUNT_STOPPED",
  "APPROVAL_REQUIRED",
  "PRIVACY_WARNING",
  "NOTE_PENDING",
  "SETTLEMENT_UNCERTAIN",
  "QUOTE_EXPIRED",
  "IDEMPOTENCY_CONFLICT",
  "PROVIDER_UNAVAILABLE",
  "PAID_NO_RESULT",
  "RECOVERY_REQUIRED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Configuration and chain-identity failures. Messages never include secret values. */
export class VeiloConfigError extends Error {
  readonly code: ErrorCode | "INVALID_CONFIG" | "RPC_UNAVAILABLE";

  constructor(code: VeiloConfigError["code"], message: string) {
    super(message);
    this.name = "VeiloConfigError";
    this.code = code;
  }
}
