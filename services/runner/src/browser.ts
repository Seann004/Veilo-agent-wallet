import { lookup as dnsLookup } from "node:dns";
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Browser, BrowserContext } from "playwright-core";
import { isPublicAddress } from "@veilo/mcp-client";

/** What one page visit returns: visible text and links, both untrusted data. */
export interface PageRead {
  url: string;
  title: string;
  text: string;
  links: Array<{ text: string; href: string }>;
}

export interface PageReader {
  read(url: string): Promise<PageRead>;
  close(): Promise<void>;
}

const MAX_TEXT = 8_000;
const MAX_LINKS = 20;
const NAV_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** Reading text needs documents, scripts, styles and data; everything heavier is refused. */
const SKIPPED_TYPES = new Set(["image", "media", "font", "manifest", "texttrack", "eventsource", "websocket", "other"]);
/** Only these page request headers are forwarded; cookies and custom headers are dropped. */
const FORWARDED_HEADERS = ["accept", "accept-language", "referer", "user-agent"];
/** Headers that describe the transfer, not the decoded body handed to the page. */
const DROPPED_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie"]);

// Runs in the page: visible text and outgoing http(s) links only.
const EXTRACT = `(() => {
  const text = (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n").slice(0, ${MAX_TEXT});
  const links = [...document.querySelectorAll("a[href]")]
    .map((a) => ({ text: (a.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 80), href: a.href }))
    .filter((l) => l.text !== "" && /^https?:/.test(l.href))
    .slice(0, ${MAX_LINKS});
  return { title: document.title.slice(0, 200), text, links };
})()`;

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|home|lan|intranet|corp)$/i;

/**
 * The rules control applies to a permitted page, for every request the page makes: http(s),
 * no credentials, default port, no local names, and a host whose every address is public.
 */
export async function publicUrl(u: URL, cache: Map<string, boolean> = new Map()): Promise<boolean> {
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || u.port !== "") return false;
  const h = u.hostname.replace(/^\[|\]$/g, "");
  const known = cache.get(h);
  if (known !== undefined) return known;
  let ok: boolean;
  if (isIP(h)) ok = isPublicAddress(h);
  else if (LOCAL_NAMES.test(h) || !h.includes(".")) ok = false;
  else {
    try {
      const addrs = await lookup(h, { all: true });
      ok = addrs.length > 0 && addrs.every((a) => isPublicAddress(a.address));
    } catch {
      ok = false;
    }
  }
  cache.set(h, ok);
  return ok;
}

class Refused extends Error {}

interface Fetched {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * One GET/HEAD with no redirects, where the address check runs in the connection's own DNS
 * lookup: the address checked is the address connected to, so rebinding cannot reach a private
 * host. The decoded body is streamed and refused once it passes MAX_RESPONSE_BYTES, and the whole
 * exchange is bounded by NAV_TIMEOUT_MS and by `signal`, not only by socket idleness.
 */
export function pinnedFetch(
  u: URL,
  method: string,
  headers: Record<string, string>,
  allowAddress: (ip: string) => boolean = isPublicAddress,
  signal?: AbortSignal,
): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const literal = u.hostname.replace(/^\[|\]$/g, "");
    if (isIP(literal) && !allowAddress(literal)) return reject(new Refused("non-public address"));
    if (signal?.aborted) return reject(new Refused("aborted"));
    const request = u.protocol === "https:" ? httpsRequest : httpRequest;
    let res: IncomingMessage | undefined;
    let decoder: Transform | null = null;
    const settle = () => {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (err: unknown) => {
      settle();
      req.destroy();
      res?.destroy();
      decoder?.destroy();
      reject(err);
    };
    const onAbort = () => fail(new Refused("aborted"));
    const deadline = setTimeout(() => fail(new Refused("timed out")), NAV_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    const req = request(
      u,
      {
        method,
        headers: { ...headers, "accept-encoding": "gzip, deflate, br" },
        timeout: NAV_TIMEOUT_MS,
        lookup: ((host: string, opts: { all?: boolean }, cb: (err: Error | null, address: unknown, family?: number) => void) => {
          dnsLookup(host, { all: true }, (err, addrs) => {
            if (err) return cb(err, opts.all ? [] : "", 4);
            if (addrs.length === 0 || addrs.some((a) => !allowAddress(a.address))) return cb(new Refused("non-public address"), opts.all ? [] : "", 4);
            if (opts.all) cb(null, addrs);
            else cb(null, addrs[0]!.address, addrs[0]!.family);
          });
        }) as unknown as LookupFunction,
      },
      (incoming: IncomingMessage) => {
        res = incoming;
        if (Number(res.headers["content-length"] ?? "0") > MAX_RESPONSE_BYTES) return fail(new Refused("response too large"));
        const encoding = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
        decoder = encoding === "gzip" || encoding === "x-gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : null;
        const stream = decoder ? res.pipe(decoder) : res;
        const chunks: Buffer[] = [];
        let total = 0;
        stream.on("data", (c: Buffer) => {
          total += c.length;
          if (total > MAX_RESPONSE_BYTES) return fail(new Refused("response too large"));
          chunks.push(c);
        });
        stream.on("error", fail);
        res.on("error", fail);
        stream.on("end", () => {
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(incoming.headers)) if (v !== undefined && !DROPPED_RESPONSE_HEADERS.has(k)) out[k] = Array.isArray(v) ? v.join(", ") : v;
          settle();
          resolve({ status: incoming.statusCode ?? 502, headers: out, body: Buffer.concat(chunks) });
        });
      },
    );
    req.on("timeout", () => fail(new Refused("timed out")));
    req.on("error", fail);
    req.end();
  });
}

/**
 * Read-only browsing in a fresh, cookie-less Chrome context per page. Every request is checked
 * against publicUrl and then fetched by pinnedFetch, whose connection refuses non-public
 * addresses; redirects are followed here hop by hop (at most five, each checked), heavy resource
 * types and responses over 5 MB are refused, WebSockets are closed, non-proxied WebRTC UDP is
 * disabled, downloads are off, and nothing is typed or submitted.
 */
export class ChromeReader implements PageReader {
  #browser: Promise<Browser> | null = null;

  constructor(
    private readonly o: {
      executablePath?: string | undefined;
      channel?: string | undefined;
      /** Tests only: replaces the public-URL rule and the connect-time public-address rule. */
      allowUrl?: (u: URL) => Promise<boolean>;
    } = {},
  ) {}

  #launch(): Promise<Browser> {
    this.#browser ??= import("playwright-core").then(({ chromium }) =>
      chromium.launch({
        headless: true,
        ...(this.o.executablePath ? { executablePath: this.o.executablePath } : { channel: this.o.channel ?? "chrome" }),
        args: ["--disable-extensions", "--disable-background-networking", "--no-first-run", "--disable-sync", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
      }),
    );
    return this.#browser;
  }

  async read(url: string): Promise<PageRead> {
    const browser = await this.#launch();
    const context: BrowserContext = await browser.newContext({ acceptDownloads: false, javaScriptEnabled: true, serviceWorkers: "block", userAgent: "VeiloAgent/1.0 (read-only)" });
    const hosts = new Map<string, boolean>();
    const allowed = (u: URL) => (this.o.allowUrl ? this.o.allowUrl(u) : publicUrl(u, hosts));
    const allowAddress = this.o.allowUrl ? () => true : isPublicAddress;
    // Cancels fetches still running when the page is done, so none outlive its context.
    const inflight = new AbortController();
    try {
      await context.routeWebSocket(/.*/, (ws) => ws.close());
      await context.route("**/*", async (route) => {
        const req = route.request();
        let u: URL;
        try {
          u = new URL(req.url());
        } catch {
          return route.abort("blockedbyclient");
        }
        if ((req.method() !== "GET" && req.method() !== "HEAD") || SKIPPED_TYPES.has(req.resourceType()) || !(await allowed(u))) return route.abort("blockedbyclient");
        // Redirects are followed here, one checked hop at a time; the browser only ever sees the final response.
        const headers = Object.fromEntries(FORWARDED_HEADERS.flatMap((k) => (req.headers()[k] ? [[k, req.headers()[k]!]] : [])));
        let target = u;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
          let resp: Fetched;
          try {
            resp = await pinnedFetch(target, req.method(), headers, allowAddress, inflight.signal);
          } catch (err) {
            return route.abort(err instanceof Refused ? "blockedbyclient" : "failed");
          }
          if (resp.status >= 300 && resp.status < 400) {
            let next: URL | null;
            try {
              next = resp.headers["location"] ? new URL(resp.headers["location"], target) : null;
            } catch {
              next = null;
            }
            if (!next || !(await allowed(next))) return route.abort("blockedbyclient");
            target = next;
            continue;
          }
          return route.fulfill({ status: resp.status, headers: resp.headers, body: resp.body });
        }
        return route.abort("blockedbyclient");
      });
      const page = await context.newPage();
      page.on("dialog", (d) => void d.dismiss());
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      // Scroll so lazily loaded content renders; nothing is clicked or typed.
      for (let i = 0; i < 4; i += 1) {
        await page.mouse.wheel(0, 1_500);
        await page.waitForTimeout(400);
      }
      if (!(await allowed(new URL(page.url())))) throw new Error("the page ended on a non-public address");
      const read = (await page.evaluate(EXTRACT)) as Omit<PageRead, "url">;
      return { url: page.url(), ...read };
    } finally {
      inflight.abort();
      await context.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    if (!this.#browser) return;
    const b = await this.#browser.catch(() => null);
    this.#browser = null;
    await b?.close().catch(() => undefined);
  }
}
