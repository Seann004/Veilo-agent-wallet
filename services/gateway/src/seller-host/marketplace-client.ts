import type { FetchLike } from "../provider/types";

export interface MarketplaceResponse {
  status: number;
  /** Parsed JSON body, or undefined when the body is empty or not JSON. Validated by callers. */
  body: unknown;
}

/** The request may or may not have reached the marketplace; callers keep their durable state and retry. */
export class MarketplaceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketplaceUnavailableError";
  }
}

export interface MarketplaceClientOptions {
  baseUrl: string;
  /** Seller-host bearer credential. Never logged or returned. */
  token: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/** Seller host → marketplace calls under `/internal/seller-host`. */
export class MarketplaceClient {
  readonly baseUrl: string;
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(o: MarketplaceClientOptions) {
    this.baseUrl = o.baseUrl.replace(/\/$/, "");
    this.#token = o.token;
    this.#fetch = o.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = o.timeoutMs ?? 15_000;
  }

  async #call(method: "GET" | "POST", path: string, body?: unknown): Promise<MarketplaceResponse> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      throw new MarketplaceUnavailableError(`marketplace request failed: ${(error as Error).name}`);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (error) {
      throw new MarketplaceUnavailableError(`marketplace response unreadable: ${(error as Error).name}`);
    }
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return { status: res.status, body: parsed };
  }

  #job(jobId: string, suffix = ""): string {
    return `/internal/seller-host/jobs/${encodeURIComponent(jobId)}${suffix}`;
  }

  getJob(jobId: string): Promise<MarketplaceResponse> {
    return this.#call("GET", this.#job(jobId));
  }

  paymentEvidence(jobId: string, body: { operationId: string; signature: string }): Promise<MarketplaceResponse> {
    return this.#call("POST", this.#job(jobId, "/payment-evidence"), body);
  }

  claim(jobId: string): Promise<MarketplaceResponse> {
    return this.#call("POST", this.#job(jobId, "/claim"), {});
  }

  heartbeat(jobId: string, body: { attemptId: string; leaseToken: string }): Promise<MarketplaceResponse> {
    return this.#call("POST", this.#job(jobId, "/heartbeat"), body);
  }

  complete(jobId: string, body: unknown): Promise<MarketplaceResponse> {
    return this.#call("POST", this.#job(jobId, "/complete"), body);
  }

  fail(jobId: string, body: { attemptId: string; leaseToken: string; code: string; uncertain: boolean }): Promise<MarketplaceResponse> {
    return this.#call("POST", this.#job(jobId, "/fail"), body);
  }

  /** Reports the manifest digest and configuration of one provider this host runs. */
  toolStatus(body: { provider: string; manifestSha256: string; configured: boolean }): Promise<MarketplaceResponse> {
    return this.#call("POST", "/internal/seller-host/tool-status", body);
  }
}
