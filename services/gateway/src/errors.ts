export type GatewayErrorCode =
  | "UNAUTHENTICATED"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "INPUT_TOO_LONG"
  | "POLICY_DENIED"
  | "BUDGET_EXCEEDED"
  | "SERVICE_NOT_ALLOWED"
  | "PRICE_CHANGED"
  | "WRONG_NETWORK"
  | "WRONG_MINT"
  | "ACCOUNT_STOPPED"
  | "SETTLEMENT_UNCERTAIN"
  | "QUOTE_EXPIRED"
  | "IDEMPOTENCY_CONFLICT"
  | "PROVIDER_UNAVAILABLE"
  | "PAID_NO_RESULT"
  | "OPERATOR_BUDGET_EXHAUSTED"
  | "PLANNING_LIMIT_REACHED"
  | "NOT_READY";

/** Errors with safe, agent-readable messages; never carries secrets or note identifiers. */
export class GatewayError extends Error {
  readonly status: number;
  readonly code: GatewayErrorCode;

  constructor(status: number, code: GatewayErrorCode, message: string) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.code = code;
  }
}
