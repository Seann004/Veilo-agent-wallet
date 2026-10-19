import { isPublicAddress, requestBounded, type Resolver } from "@veilo/mcp-client";
export type { Resolver } from "@veilo/mcp-client";

export class FetchDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchDenied";
  }
}

export interface SafeFetchPolicy {
  /** Exact origins (scheme://host[:port]) tools may fetch. */
  approvedOrigins: readonly string[];
  /** Approved origins that are explicitly configured local demo services and may resolve to loopback. */
  localServiceOrigins: readonly string[];
  maxBytes?: number;
  timeoutMs?: number;
}

/** Non-global addresses, including mapped IPv4 and reserved IPv6 ranges, are private for tool access. */
export const isPrivateAddress = (ip: string): boolean => !isPublicAddress(ip);

/**
 * Fetch for agent tools: only approved origins, no redirects, bounded size and time, and every
 * resolved address must be public unless the origin is a configured local demo service.
 */
export async function safeFetch(url: string, policy: SafeFetchPolicy, resolver?: Resolver): Promise<{ status: number; text: string }> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new FetchDenied("not a valid URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new FetchDenied("only http(s) URLs may be fetched");
  if (u.username || u.password) throw new FetchDenied("credentials in URLs are not allowed");
  if (!policy.approvedOrigins.includes(u.origin)) throw new FetchDenied("origin is not approved for tool fetches");
  const local = policy.localServiceOrigins.includes(u.origin);
  try {
    const res = await requestBounded(u, {
      resolver,
      ...(local ? { allowAddress: () => true } : {}),
      maxBytes: policy.maxBytes ?? 256 * 1024,
      timeoutMs: policy.timeoutMs ?? 15_000,
      rejectRedirects: true,
    });
    return { status: res.status, text: res.body.toString("utf8") };
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    throw new FetchDenied(message === "non-public address" ? "host resolves to a private or internal address" : message);
  }
}
