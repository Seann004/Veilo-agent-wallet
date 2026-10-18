import type { Browser } from "playwright-core";

export const SLIDE_WIDTH = 1080;
export const SLIDE_HEIGHT = 1920;
export const MIN_SLIDES = 2;
export const MAX_SLIDES = 7;

export interface RepoCard {
  owner: string;
  repo: string;
  description: string;
  language: string;
  stars: string;
}

export interface Slide {
  label: string;
  headline: string;
  accent: string;
  body: string;
  card: RepoCard | null;
  score: string;
  imageUrl: string | null;
}

export interface SlidePlan {
  slides: Slide[];
  caption: string;
}

const LIMITS = { label: 24, headline: 90, accent: 40, body: 240, owner: 39, repo: 100, description: 200, language: 30, stars: 12, score: 4, caption: 2200 } as const;

/** Control, zero-width and bidirectional-override characters: they could reorder or hide rendered text. */
function unsafeChar(code: number, keepLines: boolean): boolean {
  if (keepLines && (code === 9 || code === 10)) return false;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

function stripUnsafe(text: string, keepLines: boolean): string {
  let out = "";
  for (const ch of text) out += unsafeChar(ch.codePointAt(0)!, keepLines) ? " " : ch;
  return out;
}

/** Single-line plain text: unsafe characters dropped, whitespace collapsed, bounded. */
function clean(value: unknown, max: number): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return stripUnsafe(String(value).slice(0, max * 4), false).replace(/\s+/g, " ").trim().slice(0, max);
}

/** Everything that reaches the template as text passes through here; there is no other insertion path. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** An image URL the template may load: https, no credentials, default port, and an allowlisted host. */
export function allowedImageUrl(value: unknown, hosts: ReadonlySet<string>): string | null {
  if (typeof value !== "string" || value.length > 2048 || hosts.size === 0) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || u.port !== "" || !hosts.has(u.hostname.toLowerCase())) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Reads a slide plan object ({"slides": [...], "caption"}). Slides beyond the seventh are
 * dropped; fewer than two, or a slide without a headline, is refused.
 */
export function parseSlidePlan(plan: Record<string, unknown> | null, imageHosts: ReadonlySet<string>): SlidePlan | { problem: string } {
  const raw = Array.isArray(plan?.slides) ? (plan.slides as unknown[]) : [];
  if (raw.length < MIN_SLIDES) return { problem: `the plan needs a "slides" array of ${MIN_SLIDES} to ${MAX_SLIDES} slides` };
  const slides: Slide[] = [];
  for (const [i, item] of raw.slice(0, MAX_SLIDES).entries()) {
    const s = typeof item === "object" && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
    const headline = clean(s.headline, LIMITS.headline);
    if (headline === "") return { problem: `slide ${i + 1} has no headline` };
    const c = typeof s.card === "object" && s.card !== null && !Array.isArray(s.card) ? (s.card as Record<string, unknown>) : null;
    const card =
      c && clean(c.repo, LIMITS.repo) !== ""
        ? { owner: clean(c.owner, LIMITS.owner), repo: clean(c.repo, LIMITS.repo), description: clean(c.description, LIMITS.description), language: clean(c.language, LIMITS.language), stars: clean(c.stars, LIMITS.stars) }
        : null;
    slides.push({
      label: clean(s.label, LIMITS.label),
      headline,
      accent: clean(s.accent, LIMITS.accent),
      body: clean(s.body, LIMITS.body),
      card,
      score: clean(s.score, LIMITS.score),
      imageUrl: allowedImageUrl(s.imageUrl, imageHosts),
    });
  }
  const caption = typeof plan?.caption === "string" ? stripUnsafe(plan.caption.slice(0, LIMITS.caption), true).trim() : "";
  return { slides, caption };
}

/** Headline split around the first case-insensitive match of the accent, each part escaped. */
function headlineHtml(headline: string, accent: string): string {
  const at = accent === "" ? -1 : headline.toLowerCase().indexOf(accent.toLowerCase());
  if (at < 0) return escapeHtml(headline);
  return `${escapeHtml(headline.slice(0, at))}<span class="accent">${escapeHtml(headline.slice(at, at + accent.length))}</span>${escapeHtml(headline.slice(at + accent.length))}`;
}

function headlineSize(headline: string): number {
  if (headline.length <= 28) return 128;
  if (headline.length <= 48) return 108;
  if (headline.length <= 70) return 92;
  return 80;
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${SLIDE_WIDTH}px;height:${SLIDE_HEIGHT}px;background:#dcd9d4;overflow:hidden}
body{padding:48px;font-family:"Helvetica Neue",Helvetica,Arial,"Liberation Sans",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.panel{width:100%;height:100%;background:#1f1e1c;border-radius:40px;padding:96px 84px 240px;display:flex;flex-direction:column;color:#f1ede6}
.content{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;justify-content:center;gap:56px}
.mono{font-family:"SF Mono",Menlo,"DejaVu Sans Mono","Liberation Mono",ui-monospace,monospace}
.top{display:flex;justify-content:space-between;align-items:center;font-size:30px;letter-spacing:.06em;color:#8f8a82;text-transform:lowercase}
h1{font-weight:800;letter-spacing:-.035em;line-height:1.02;text-transform:lowercase;color:#f1ede6;overflow-wrap:anywhere}
.accent{color:#c97b5a}
.body{font-size:42px;line-height:1.38;color:#b8b2a8;overflow-wrap:anywhere}
.card{background:#292826;border:2px solid #3a3835;border-radius:28px;padding:44px 48px;display:flex;flex-direction:column;gap:22px}
.repo{font-size:38px;color:#f1ede6;overflow-wrap:anywhere}
.repo .owner{color:#8f8a82}
.desc{font-size:34px;line-height:1.4;color:#b8b2a8;overflow-wrap:anywhere}
.meta{display:flex;gap:40px;font-size:30px;color:#8f8a82}
.dot{display:inline-block;width:22px;height:22px;border-radius:50%;background:#c97b5a;margin-right:14px;vertical-align:-2px}
.pill{align-self:flex-start;border:3px solid #c97b5a;color:#c97b5a;border-radius:999px;padding:18px 40px;font-size:34px;text-transform:lowercase}
.shot{flex:0 1 720px;min-height:240px;border-radius:28px;border:2px solid #3a3835;overflow:hidden;background:#292826}
.shot img{width:100%;height:100%;object-fit:cover;display:block}
`;

/**
 * One slide as a self-contained document. Every model-supplied value is escaped text; the only URL
 * is an allowlisted image, and the content security policy forbids scripts and any other load.
 */
export function slideHtml(slide: Slide, index: number, total: number, imageHosts: ReadonlySet<string>): string {
  const n = String(index + 1).padStart(2, "0");
  const label = slide.label === "" ? n : `${n} · ${slide.label.replace(/^\d{1,2}\s*[·.:-]\s*/, "")}`;
  const imgSrc = [...imageHosts].map((h) => `https://${h}`).join(" ");
  const card = slide.card
    ? `<div class="card"><div class="repo mono">${slide.card.owner ? `<span class="owner">${escapeHtml(slide.card.owner)}/</span>` : ""}${escapeHtml(slide.card.repo)}</div>${
        slide.card.description ? `<div class="desc">${escapeHtml(slide.card.description)}</div>` : ""
      }<div class="meta mono">${slide.card.language ? `<span><span class="dot"></span>${escapeHtml(slide.card.language)}</span>` : ""}${slide.card.stars ? `<span>★ ${escapeHtml(slide.card.stars)}</span>` : ""}</div></div>`
    : "";
  const pill = slide.card ? `<div class="pill mono">my score ${slide.score ? escapeHtml(slide.score) : "__"} / 10</div>` : "";
  const shot = slide.imageUrl ? `<div class="shot"><img alt="" src="${escapeHtml(slide.imageUrl)}"></div>` : "";
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${imgSrc || "'none'"}">`,
    `<style>${CSS}</style></head><body><div class="panel">`,
    `<div class="top mono"><span>${escapeHtml(label)}</span><span>${index + 1}/${total}</span></div>`,
    `<div class="content">`,
    `<h1 style="font-size:${headlineSize(slide.headline)}px">${headlineHtml(slide.headline, slide.accent)}</h1>`,
    slide.body ? `<p class="body">${escapeHtml(slide.body)}</p>` : "",
    card,
    pill,
    shot,
    "</div></div></body></html>",
  ].join("");
}

/** Renders one slide document to a PNG. */
export interface SlideRenderer {
  render(html: string, imageHosts: ReadonlySet<string>): Promise<Uint8Array>;
  close(): Promise<void>;
}

/**
 * Headless Chrome through playwright-core, scripts off. Every request is refused except GETs of
 * images on allowlisted https hosts, so a slide can never reach the network otherwise.
 */
export class ChromeSlideRenderer implements SlideRenderer {
  #browser: Promise<Browser> | null = null;

  constructor(private readonly o: { executablePath?: string | undefined; channel?: string | undefined } = {}) {}

  #launch(): Promise<Browser> {
    this.#browser ??= import("playwright-core").then(({ chromium }) =>
      chromium.launch({
        headless: true,
        ...(this.o.executablePath ? { executablePath: this.o.executablePath } : { channel: this.o.channel ?? "chrome" }),
        args: ["--disable-extensions", "--disable-background-networking", "--no-first-run", "--disable-sync", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
      }),
    );
    this.#browser.catch(() => {
      this.#browser = null;
    });
    return this.#browser;
  }

  async render(html: string, imageHosts: ReadonlySet<string>): Promise<Uint8Array> {
    const browser = await this.#launch();
    const context = await browser.newContext({ viewport: { width: SLIDE_WIDTH, height: SLIDE_HEIGHT }, deviceScaleFactor: 1, javaScriptEnabled: false, acceptDownloads: false, serviceWorkers: "block" });
    try {
      await context.routeWebSocket(/.*/, (ws) => ws.close());
      await context.route("**/*", (route) => {
        const req = route.request();
        if (req.method() === "GET" && req.resourceType() === "image" && allowedImageUrl(req.url(), imageHosts)) return route.continue();
        return route.abort("blockedbyclient");
      });
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: "load", timeout: 20_000 });
      return await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: SLIDE_WIDTH, height: SLIDE_HEIGHT }, timeout: 20_000 });
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
