import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { remoteOriginProblem } from "@veilo/contracts/marketplace";
import type { FetchLike } from "../integration/gateway-client";
import { isPrivateAddress } from "./addresses";

export class SellerOriginDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SellerOriginDenied";
  }
}

export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

export interface SellerOriginPolicyOptions {
  /**
   * Exact origins of operator-allowlisted local test sellers. Only these may use http or
   * resolve to loopback/private addresses.
   */
  localTestOrigins?: readonly string[];
  resolver?: Resolver;
  maxResponseBytes?: number;
}

function normalizeOrigin(value: string): string | null {
  try {
    const u = new URL(value);
    return u.origin === value.replace(/\/$/, "") ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Admission and connection policy for marketplace seller origins. A seller origin is a bare
 * public https DNS name; every connection resolves the host again and refuses private,
 * loopback, link-local and metadata addresses, so a DNS change after review cannot redirect
 * spending traffic inward. Redirects are never followed.
 */
export class SellerOriginPolicy {
  readonly #local: ReadonlySet<string>;
  readonly #resolve: Resolver;
  readonly #maxBytes: number;

  constructor(o: SellerOriginPolicyOptions = {}) {
    this.#local = new Set((o.localTestOrigins ?? []).map((x) => normalizeOrigin(x.trim())).filter((x): x is string => x !== null));
    this.#resolve = o.resolver ?? defaultResolver;
    this.#maxBytes = o.maxResponseBytes ?? 4 * 1024 * 1024;
  }

  isLocalTest(origin: string): boolean {
    return this.#local.has(origin);
  }

  /** Returns why an origin may not be paid, or null when it is admissible. */
  problem(origin: string): string | null {
    if (this.#local.has(origin)) return null;
    const p = remoteOriginProblem(origin);
    return p === null ? null : `seller origin ${p}`;
  }

  /** Resolves and checks a host the same way a connection does. */
  async checkHost(origin: string): Promise<void> {
    const problem = this.problem(origin);
    if (problem) throw new SellerOriginDenied(problem);
    const host = new URL(origin).hostname.replace(/^\[|\]$/g, "");
    await this.#addresses(host, this.#local.has(origin));
  }

  async #addresses(host: string, local: boolean): Promise<string[]> {
    if (isIP(host)) {
      if (!local) throw new SellerOriginDenied("seller origin must be a DNS name");
      return [host];
    }
    const addrs = await this.#resolve(host);
    if (addrs.length === 0) throw new SellerOriginDenied("seller host did not resolve");
    if (!local && addrs.some(isPrivateAddress)) throw new SellerOriginDenied("seller host resolves to a private or internal address");
    return addrs;
  }

  /** A fetch bound to one seller origin. Each request opens its own connection and re-resolves. */
  fetchFor(origin: string): FetchLike {
    return async (input, init) => {
      const url = new URL(input);
      if (url.origin !== origin) throw new SellerOriginDenied("request leaves the approved seller origin");
      const problem = this.problem(origin);
      if (problem) throw new SellerOriginDenied(problem);
      const local = this.#local.has(origin);
      const host = url.hostname.replace(/^\[|\]$/g, "");
      if (isIP(host)) await this.#addresses(host, local);
      const lookup: LookupFunction = (hostname, options, callback) => {
        this.#addresses(hostname, local).then(
          (addrs) => {
            if (options.all) callback(null, addrs.map((a) => ({ address: a, family: isIP(a) })));
            else callback(null, addrs[0] as string, isIP(addrs[0] as string));
          },
          (error: Error) => callback(error as NodeJS.ErrnoException, "", 0),
        );
      };
      return this.#request(url, init ?? {}, lookup);
    };
  }

  #request(url: URL, init: RequestInit, lookup: LookupFunction): Promise<Response> {
    const mod = url.protocol === "https:" ? https : url.protocol === "http:" ? http : undefined;
    if (!mod) return Promise.reject(new SellerOriginDenied("seller origin must use http(s)"));
    const headers: Record<string, string> = {};
    if (init.headers) for (const [k, v] of new Headers(init.headers).entries()) headers[k] = v;
    const body = typeof init.body === "string" ? init.body : undefined;
    if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
    return new Promise<Response>((resolve, reject) => {
      const req = mod.request(
        url,
        { method: init.method ?? "GET", headers, agent: false, lookup, ...(init.signal ? { signal: init.signal } : {}) },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.resume();
            reject(new SellerOriginDenied("redirects are not followed"));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > this.#maxBytes) req.destroy(new SellerOriginDenied("seller response exceeds the size bound"));
            else chunks.push(c);
          });
          res.on("end", () => {
            const h = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (Array.isArray(v)) for (const x of v) h.append(k, x);
              else if (v !== undefined) h.set(k, v);
            }
            const nullBody = status === 204 || status === 205 || status === 304;
            resolve(new Response(nullBody ? null : Buffer.concat(chunks), { status, headers: h }));
          });
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }
}
