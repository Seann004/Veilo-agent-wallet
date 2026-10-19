import { lookup } from "node:dns/promises";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

const V4_SPECIAL = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) V4_SPECIAL.addSubnet(net, prefix, "ipv4");
const V6_GLOBAL = new BlockList();
V6_GLOBAL.addSubnet("2000::", 3, "ipv6");
// Inside 2000::/3 but tunnelling, documentation or otherwise not plain global unicast.
const V6_SPECIAL = new BlockList();
for (const [net, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) V6_SPECIAL.addSubnet(net, prefix, "ipv6");

/** True only for global unicast: any IPv6 outside 2000::/3 (mapped, NAT64, ULA, link-local) is refused. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !V4_SPECIAL.check(address, "ipv4");
  if (family === 6) return V6_GLOBAL.check(address, "ipv6") && !V6_SPECIAL.check(address, "ipv6");
  return false;
}

export type Resolver = (host: string) => Promise<string[]>;
const resolveHost: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export interface BoundedResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

interface RequestOptions {
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  allowAddress?: ((address: string) => boolean) | undefined;
  resolver?: Resolver | undefined;
  maxBytes?: number | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  rejectRedirects?: boolean | undefined;
}

const DROPPED_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie"]);

/**
 * One request, no redirects. DNS is checked by the connection's lookup; neither a preflight
 * check nor a cached browser verdict authorizes the address actually connected to. The whole
 * exchange has a deadline, and the decoded stream is destroyed as soon as it exceeds the cap.
 */
export function requestBounded(u: URL, o: RequestOptions = {}): Promise<BoundedResponse> {
  return new Promise((resolve, reject) => {
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) return reject(new Error("only http(s) URLs without credentials are allowed"));
    const max = o.maxBytes ?? 1_048_576;
    const timeout = o.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(max) || max < 0 || !Number.isFinite(timeout) || timeout <= 0) return reject(new Error("invalid request bounds"));
    const allow = o.allowAddress ?? isPublicAddress;
    const resolver = o.resolver ?? resolveHost;
    const literal = u.hostname.replace(/^\[|\]$/g, "");
    if (isIP(literal) && !allow(literal)) return reject(new Error("non-public address"));
    if (o.signal?.aborted) return reject(new Error("aborted"));
    let req: ClientRequest | undefined;
    let res: IncomingMessage | undefined;
    let decoder: Transform | null = null;
    let settled = false;
    const cleanup = () => { clearTimeout(deadline); o.signal?.removeEventListener("abort", onAbort); };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      req?.destroy();
      res?.destroy();
      decoder?.destroy();
      reject(error);
    };
    const onAbort = () => fail(new Error("aborted"));
    const deadline = setTimeout(() => fail(new Error("timed out")), timeout);
    o.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      req = (u.protocol === "https:" ? httpsRequest : httpRequest)(u, {
        method: o.method ?? "GET",
        headers: { ...o.headers, "accept-encoding": "gzip, deflate, br" },
        agent: false,
        timeout,
        lookup: ((host: string, opts: { all?: boolean }, cb: (err: Error | null, address: unknown, family?: number) => void) => {
          void resolver(host).then((addresses) => {
            if (settled) return;
            if (addresses.length === 0 || addresses.some((address) => !isIP(address) || !allow(address))) return cb(new Error("non-public address"), opts.all ? [] : "", 4);
            const addrs = addresses.map(address => ({ address, family: isIP(address) }));
            if (opts.all) cb(null, addrs);
            else cb(null, addrs[0]!.address, addrs[0]!.family);
          }, (error: Error) => cb(error, opts.all ? [] : "", 4));
        }) as unknown as LookupFunction,
      }, (incoming) => {
        res = incoming;
        if (settled) { res.destroy(); return; }
        const status = incoming.statusCode ?? 502;
        if (o.rejectRedirects && status >= 300 && status < 400) return fail(new Error("redirects are not followed"));
        if (Number(res.headers["content-length"] ?? "0") > max) return fail(new Error("response too large: exceeds the size bound"));
        const encoding = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
        if (encoding && !["identity", "gzip", "x-gzip", "deflate", "br"].includes(encoding)) return fail(new Error("unsupported content encoding"));
        decoder = encoding === "gzip" || encoding === "x-gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : null;
        const stream = decoder ? res.pipe(decoder) : res;
        const chunks: Buffer[] = [];
        let total = 0;
        stream.on("data", (chunk: Buffer) => {
          if (settled) return;
          total += chunk.length;
          if (total > max) return fail(new Error("response too large: exceeds the size bound"));
          chunks.push(chunk);
        });
        stream.on("error", fail);
        res.on("error", fail);
        res.on("aborted", () => fail(new Error("response aborted")));
        stream.on("end", () => {
          if (settled) return;
          settled = true;
          cleanup();
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(incoming.headers)) if (v !== undefined && !DROPPED_HEADERS.has(k)) headers[k] = Array.isArray(v) ? v.join(", ") : v;
          resolve({ status, headers, body: Buffer.concat(chunks) });
        });
      });
      req.on("timeout", () => fail(new Error("timed out")));
      req.on("error", fail);
      req.end(o.body);
    } catch (error) { fail(error); }
  });
}
