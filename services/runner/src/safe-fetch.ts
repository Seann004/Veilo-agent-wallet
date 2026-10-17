import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

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

export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

function ipv4Private(ip: string): boolean {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved and IPv4-mapped private ranges. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return ipv4Private(ip);
  if (v !== 6) return true;
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1]) return ipv4Private(mapped[1]);
  return lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("ff");
}

/**
 * Fetch for agent tools: only approved origins, no redirects, bounded size and time, and every
 * resolved address must be public unless the origin is a configured local demo service.
 */
export async function safeFetch(url: string, policy: SafeFetchPolicy, resolver: Resolver = defaultResolver): Promise<{ status: number; text: string }> {
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
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : await resolver(host);
  if (addresses.length === 0) throw new FetchDenied("host did not resolve");
  if (!local && addresses.some(isPrivateAddress)) throw new FetchDenied("host resolves to a private or internal address");
  const res = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(policy.timeoutMs ?? 15_000) });
  if (res.status >= 300 && res.status < 400) throw new FetchDenied("redirects are not followed");
  const max = policy.maxBytes ?? 256 * 1024;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new FetchDenied("response exceeds the size bound");
  return { status: res.status, text: buf.toString("utf8") };
}
