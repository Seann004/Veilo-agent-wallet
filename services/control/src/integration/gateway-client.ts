import type { CreditBalanceView } from "@veilo/contracts/gateway";

export interface GatewayResponse {
  status: number;
  // Gateway bodies are validated field by field by callers.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  headers: Headers;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class GatewayUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayUnreachableError";
  }
}

export interface GatewayClientOptions {
  baseUrl: string;
  /** Bearer token of the workspace's single gateway account; agents never see it. */
  accountToken: string;
  /** Bearer token for operator-sponsored planning, when configured. */
  planningToken?: string | undefined;
  /** Gateway identity named in usage permits. */
  identity: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/**
 * Control's authenticated client for the Veilo gateway. Network failures surface as
 * GatewayUnreachableError so callers can keep the existing operation unresolved.
 */
export class GatewayClient {
  readonly identity: string;
  readonly baseUrl: string;
  readonly #token: string;
  readonly #planningToken: string | undefined;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  #accountId: string | undefined;

  constructor(o: GatewayClientOptions) {
    this.baseUrl = o.baseUrl.replace(/\/$/, "");
    this.identity = o.identity;
    this.#token = o.accountToken;
    this.#planningToken = o.planningToken;
    this.#fetch = o.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = o.timeoutMs ?? 90_000;
  }

  get planningConfigured(): boolean {
    return this.#planningToken !== undefined;
  }

  async #call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, token = this.#token): Promise<GatewayResponse> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      throw new GatewayUnreachableError(`gateway request failed: ${(error as Error).name}`);
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  async balance(): Promise<CreditBalanceView> {
    const r = await this.#call("GET", "/credits/balance");
    if (r.status !== 200) throw new GatewayUnreachableError(`credit balance unavailable (HTTP ${r.status})`);
    this.#accountId = r.body.accountId as string;
    return r.body as CreditBalanceView;
  }

  async accountId(): Promise<string> {
    if (this.#accountId === undefined) await this.balance();
    return this.#accountId as string;
  }

  quote(operationId: string, sku: string, input: unknown, requestDigest: string): Promise<GatewayResponse> {
    return this.#call("POST", "/quotes", { operationId, sku, input, requestDigest });
  }

  execute(quoteId: string, operationId: string, requestDigest: string, paymentSignature?: string): Promise<GatewayResponse> {
    return this.#call(
      "POST",
      `/v1/purchases/${encodeURIComponent(quoteId)}/execute`,
      { operationId, requestDigest },
      paymentSignature === undefined ? {} : { "payment-signature": paymentSignature },
    );
  }

  result(quoteId: string): Promise<GatewayResponse> {
    return this.#call("GET", `/v1/purchases/${encodeURIComponent(quoteId)}/result`);
  }

  usageAuthorize(permit: string): Promise<GatewayResponse> {
    return this.#call("POST", "/usage/authorize", { permit });
  }

  usageExecute(operationId: string, reservationId: string, input: unknown): Promise<GatewayResponse> {
    return this.#call("POST", "/usage/execute", { operationId, reservationId, input });
  }

  usageGet(operationId: string): Promise<GatewayResponse> {
    return this.#call("GET", `/usage/${encodeURIComponent(operationId)}`);
  }

  usageRelease(operationId: string, reservationId: string): Promise<GatewayResponse> {
    return this.#call("POST", `/usage/${encodeURIComponent(operationId)}/release`, { reservationId });
  }

  planning(body: { taskRef: string; purpose: string; messages: unknown[]; maxOutputTokens?: number }): Promise<GatewayResponse> {
    if (this.#planningToken === undefined) throw new GatewayUnreachableError("planning credential is not configured");
    return this.#call("POST", "/planning/complete", body, {}, this.#planningToken);
  }
}
