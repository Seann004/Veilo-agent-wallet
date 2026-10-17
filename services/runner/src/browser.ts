import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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

/**
 * Read-only browsing in a fresh, cookie-less Chrome context per page. Every request (page,
 * script, image, frame) is fetched here with redirects off and checked against publicUrl, and
 * every redirect target is checked before the browser may follow it; WebSockets are closed,
 * downloads are off, and nothing is typed or submitted. The final page URL is checked again.
 * DNS is resolved separately for the check and for the fetch, so a rebinding window remains;
 * browsing is therefore opt-in per agent and bounded per task by control.
 */
export class ChromeReader implements PageReader {
  #browser: Promise<Browser> | null = null;

  constructor(
    private readonly o: {
      executablePath?: string | undefined;
      channel?: string | undefined;
      /** Tests only: replaces the public-URL rule. */
      allowUrl?: (u: URL) => Promise<boolean>;
    } = {},
  ) {}

  #launch(): Promise<Browser> {
    this.#browser ??= import("playwright-core").then(({ chromium }) =>
      chromium.launch({
        headless: true,
        ...(this.o.executablePath ? { executablePath: this.o.executablePath } : { channel: this.o.channel ?? "chrome" }),
        args: ["--disable-extensions", "--disable-background-networking", "--no-first-run", "--disable-sync"],
      }),
    );
    return this.#browser;
  }

  async read(url: string): Promise<PageRead> {
    const browser = await this.#launch();
    const context: BrowserContext = await browser.newContext({ acceptDownloads: false, javaScriptEnabled: true, serviceWorkers: "block", userAgent: "VeiloAgent/1.0 (read-only)" });
    const hosts = new Map<string, boolean>();
    const allowed = (u: URL) => (this.o.allowUrl ? this.o.allowUrl(u) : publicUrl(u, hosts));
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
        if ((req.method() !== "GET" && req.method() !== "HEAD") || !(await allowed(u))) return route.abort("blockedbyclient");
        let resp;
        try {
          // Redirect hops never reach this handler, so each one is fetched and checked here.
          resp = await route.fetch({ maxRedirects: 0, timeout: NAV_TIMEOUT_MS });
        } catch {
          return route.abort("failed");
        }
        if (resp.status() >= 300 && resp.status() < 400) {
          const location = resp.headers()["location"];
          let next: URL | null;
          try {
            next = location ? new URL(location, u) : null;
          } catch {
            next = null;
          }
          if (!next || !(await allowed(next))) return route.abort("blockedbyclient");
        }
        return route.fulfill({ response: resp });
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
