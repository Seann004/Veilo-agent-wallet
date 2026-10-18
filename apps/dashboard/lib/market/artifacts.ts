/** How a stored step output is shown to the owner. All text stays untrusted. */
export type ArtifactView =
  | { type: "markdown"; text: string }
  | { type: "gallery"; images: string[]; caption: string }
  | { type: "post"; platform: string; postId: string | null; slides: number | null; published: boolean }
  | { type: "plain"; text: string };

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Only https URLs may be loaded as thumbnails or opened. */
export function httpsImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    return obj(JSON.parse(text));
  } catch {
    return null;
  }
}

export function describeArtifact(kind: string | null, text: string): ArtifactView {
  if (kind === "markdown" || kind === "text/markdown") return { type: "markdown", text };
  const data = kind === "json" || kind === "draft_post" || kind === "publish" ? parseJson(text) : null;
  if (!data) return { type: "plain", text };
  if (kind === "draft_post" || kind === "publish" || typeof data.zernioPostId === "string") {
    const state = typeof data.state === "string" ? data.state : "";
    const published = kind === "publish" || (/^published\b/i.test(state) && !/publish it/i.test(state));
    return {
      type: "post",
      platform: typeof data.platform === "string" && data.platform ? data.platform : "social",
      postId: typeof data.zernioPostId === "string" ? data.zernioPostId : null,
      slides: typeof data.slides === "number" && Number.isFinite(data.slides) ? data.slides : null,
      published,
    };
  }
  if (Array.isArray(data.images)) {
    const images = data.images.map(httpsImageUrl).filter((u): u is string => u !== null);
    return { type: "gallery", images, caption: typeof data.caption === "string" ? data.caption : "" };
  }
  return { type: "plain", text };
}

const PLATFORM: Record<string, string> = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube" };

/** One plain sentence for a social post artifact. */
export function postSentence(v: Extract<ArtifactView, { type: "post" }>): string {
  const name = PLATFORM[v.platform.toLowerCase()] ?? v.platform;
  const slides = v.slides ? ` (${v.slides} slide${v.slides === 1 ? "" : "s"})` : "";
  return v.published ? `Posted to ${name}${slides}` : `Sent to ${name} inbox as a draft${slides}`;
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
