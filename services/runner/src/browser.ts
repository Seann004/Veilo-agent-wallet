import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Browser, BrowserContext } from "playwright-core";
import { isPrivateAddress } from "./safe-fetch";

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

/** True when the host is a public name or address; private, loopback and link-local are refused. */
async function publicHost(host: string, cache: Map<string, boolean>): Promise<boolean> {
  const h = host.replace(/^\[|\]$/g, "");
  const known = cache.get(h);
  if (known !== undefined) return known;
  let ok: boolean;
  if (isIP(h)) ok = !isPrivateAddress(h);
  else {
    try {
      const addrs = await lookup(h, { all: true });
      ok = addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address));
    } catch {
      ok = false;
    }
  }
  cache.set(h, ok);
  return ok;
}

/**
 * Read-only browsing in a fresh, cookie-less Chrome context per page. Every request (page,
 * script, image, frame) is checked: only GET and HEAD over http(s) to public hosts go out;
 * anything else is aborted, downloads are off, and nothing is typed or submitted. The browser's
 * own DNS lookup can still differ from this check (a rebinding window), so browsing is opt-in
 * per agent and bounded per task by control.
 */
export class ChromeReader implements PageReader {
  #browser: Promise<Browser> | null = null;

  constructor(private readonly o: { executablePath?: string | undefined; channel?: string | undefined } = {}) {}

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
    try {
      await context.route("**/*", async (route) => {
        const req = route.request();
        let u: URL;
        try {
          u = new URL(req.url());
        } catch {
          return route.abort("blockedbyclient");
        }
        const allowed = (req.method() === "GET" || req.method() === "HEAD") && (u.protocol === "https:" || u.protocol === "http:") && (await publicHost(u.hostname, hosts));
        return allowed ? route.continue() : route.abort("blockedbyclient");
      });
      const page = await context.newPage();
      page.on("dialog", (d) => void d.dismiss());
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      // Scroll so lazily loaded content renders; nothing is clicked or typed.
      for (let i = 0; i < 4; i += 1) {
        await page.mouse.wheel(0, 1_500);
        await page.waitForTimeout(400);
      }
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
