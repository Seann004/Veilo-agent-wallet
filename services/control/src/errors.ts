import { API_ERROR_STATUS, type ApiErrorCode, type ApiErrorBody } from "@veilo/contracts";

/** Domain or transport failure with a safe, actionable message (no secrets, no note identifiers). */
export class ControlError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.name = "ControlError";
    this.code = code;
    this.status = API_ERROR_STATUS[code];
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message } };
  }
}

export const deny = (code: ApiErrorCode, message: string): never => {
  throw new ControlError(code, message);
};
