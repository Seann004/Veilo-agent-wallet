import { randomBytes } from "node:crypto";
import { CONTROLLER_HEADERS, controllerSigningMessage } from "@veilo/contracts/marketplace";
import { sha256Hex } from "@veilo/contracts/gateway";
import type { FetchLike } from "../integration/gateway-client";
import type { ControllerIdentity } from "./controller-identity";

export class MarketplaceUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketplaceUnreachableError";
  }
}

export interface MarketplaceReply {
  status: number;
  // Marketplace bodies are validated with the shared schemas by callers.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** MARKETPLACE_URL must be https, or plain http only on loopback for local tests. */
export function marketplaceUrlProblem(value: string): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return "MARKETPLACE_URL is not a URL";
  }
  if (u.username || u.password || u.search || u.hash) return "MARKETPLACE_URL must not contain credentials, a query or a fragment";
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) return null;
  return "MARKETPLACE_URL must use https (http is accepted only on loopback)";
}

export interface MarketplaceClientOptions {
  baseUrl: string;
  identity: ControllerIdentity;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Outbound-only client for the marketplace. Each controller request is signed over its method,
 * path, exact body bytes, a fresh nonce and the current time, so the marketplace can reject a
 * replay, a different route or a stale request. Catalogue reads are public and unsigned.
 */
export class MarketplaceClient {
  readonly baseUrl: string;
  readonly #identity: ControllerIdentity;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #now: () => number;

  constructor(o: MarketplaceClientOptions) {
    const problem = marketplaceUrlProblem(o.baseUrl);
    if (problem) throw new Error(problem);
    this.baseUrl = o.baseUrl.replace(/\/$/, "");
    this.#identity = o.identity;
    this.#fetch = o.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = o.timeoutMs ?? 15_000;
    this.#now = o.now ?? Date.now;
  }

  get keyId(): string {
    return this.#identity.keyId;
  }

  signedHeaders(method: string, url: string, bodyText: string): Record<string, string> {
    const u = new URL(url);
    const timestamp = new Date(this.#now()).toISOString();
    const nonce = randomBytes(18).toString("base64url");
    const message = controllerSigningMessage({
      method,
      path: `${u.pathname}${u.search}`,
      bodyDigest: sha256Hex(bodyText),
      timestamp,
      nonce,
      keyId: this.#identity.keyId,
    });
    return {
      [CONTROLLER_HEADERS.keyId]: this.#identity.keyId,
      [CONTROLLER_HEADERS.timestamp]: timestamp,
      [CONTROLLER_HEADERS.nonce]: nonce,
      [CONTROLLER_HEADERS.signature]: this.#identity.sign(message),
    };
  }

  async #send(method: string, path: string, body: unknown, signed: boolean): Promise<MarketplaceReply> {
    const url = `${this.baseUrl}${path}`;
    const bodyText = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(signed ? this.signedHeaders(method, url, bodyText) : {}),
    };
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body: bodyText } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new MarketplaceUnreachableError(`marketplace request failed: ${(error as Error).name}`);
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return { status: res.status, body: parsed };
  }

  signed(method: "GET" | "POST", path: string, body?: unknown): Promise<MarketplaceReply> {
    return this.#send(method, path, body, true);
  }

  publicGet(path: string): Promise<MarketplaceReply> {
    return this.#send("GET", path, undefined, false);
  }
}
