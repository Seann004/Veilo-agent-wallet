import {
  isSolanaError,
  SOLANA_ERROR__ACCOUNTS__ACCOUNT_NOT_FOUND,
  SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_NOT_AVAILABLE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_STATUS_NOT_AVAILABLE_YET,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
} from "@solana/kit";

/**
 * RPC failures that say nothing about chain state: the request was rejected, lost or answered
 * by a node that is behind. Before a signature exists they are safe to retry.
 */
const TRANSIENT_SOLANA_CODES = new Set<number>([
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_NOT_AVAILABLE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_STATUS_NOT_AVAILABLE_YET,
  // The mint exists (checked at startup); a missing account comes from a lagging node.
  SOLANA_ERROR__ACCOUNTS__ACCOUNT_NOT_FOUND,
]);

const NETWORK_CODES = /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|UND_ERR_[A-Z_]+)$/;
const RATE_LIMITED = /HTTP error \(429\)|Too Many Requests/;

/** Only these context fields are logged: no headers, transaction bytes, keys or URLs. */
const SAFE_CONTEXT_KEYS = ["__code", "statusCode", "message", "__serverMessage"] as const;

function clean(value: string): string {
  return value.replace(/https?:\/\/[^\s"')]+/g, (url) => {
    try {
      return `${new URL(url).origin}/…`;
    } catch {
      return "<url>";
    }
  }).slice(0, 200);
}

function networkCode(error: unknown): string | undefined {
  for (let e: unknown = error, depth = 0; e && typeof e === "object" && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_CODES.test(code)) return code;
  }
  return undefined;
}

/** True when the failure is an RPC, rate-limit, timeout or network error (never a policy refusal). */
export function isTransientRpcError(error: unknown): boolean {
  if (isSolanaError(error)) return TRANSIENT_SOLANA_CODES.has(error.context.__code);
  const e = error as { name?: unknown; message?: unknown } | null;
  const name = typeof e?.name === "string" ? e.name : "";
  const message = typeof e?.message === "string" ? e.message : "";
  if (name === "AbortError" || name === "TimeoutError") return true;
  if (name === "TypeError" && /fetch failed/.test(message)) return true;
  if (RATE_LIMITED.test(message)) return true;
  return networkCode(error) !== undefined;
}

/** One-line description safe for logs and reasons: error class, Solana error code and whitelisted context. */
export function describeError(error: unknown): string {
  if (isSolanaError(error)) {
    const ctx = error.context as Record<string, unknown>;
    const parts = SAFE_CONTEXT_KEYS.flatMap((k) => {
      const v = ctx[k];
      if (typeof v === "number" || typeof v === "boolean") return [`${k}=${v}`];
      if (typeof v === "string") return [`${k}=${JSON.stringify(clean(v))}`];
      return [];
    });
    return `SolanaError ${parts.join(" ")}`.trim();
  }
  const e = error as { name?: unknown; message?: unknown } | null;
  const name = typeof e?.name === "string" ? e.name : "Error";
  const code = networkCode(error);
  // Messages of non-network errors are not logged: they may quote request or transaction data.
  const message = isTransientRpcError(error) && typeof e?.message === "string" ? ` ${JSON.stringify(clean(e.message))}` : "";
  return `${name}${code ? ` code=${code}` : ""}${message}`;
}
