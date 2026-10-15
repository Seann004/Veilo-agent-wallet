import { API_ERROR_STATUS, type ApiErrorCode } from "@veilo/contracts";

/** Safe, actionable failure. Messages never contain note secrets or key material. */
export class WalletError extends Error {
  override readonly name = "WalletError";
  readonly status: number;
  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.status = API_ERROR_STATUS[code];
  }
}
