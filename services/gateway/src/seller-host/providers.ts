import { PROVIDER_MANIFESTS, toolManifestDigest, type ArtifactKind, type ToolManifest, type ToolProvider } from "@veilo/contracts/marketplace";

export { PROVIDER_MANIFESTS };

export const PROVIDER_NOT_CONFIGURED = "Provider not configured";

export type ProviderResult =
  | { status: "succeeded"; artifact: { kind: ArtifactKind; url?: string; text?: string; providerJobId: string } }
  | { status: "failed"; code: string; message: string }
  /** The provider may have accepted the job; it is never submitted again. */
  | { status: "uncertain"; message: string };

export interface ProviderRunContext {
  /** Stable per purchase; sent as the provider idempotency key where supported. */
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface ProviderAdapter {
  readonly provider: ToolProvider;
  readonly manifest: ToolManifest;
  readonly manifestSha256: string;
  readonly configured: boolean;
  run(tool: string, inputs: Record<string, string>, ctx: ProviderRunContext): Promise<ProviderResult>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface AdapterOptions {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  maxPolls?: number;
}

/** A media URL from a provider is data: https only, no credentials, bounded length. It is never fetched here. */
export function safeMediaUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

abstract class BaseAdapter implements ProviderAdapter {
  abstract readonly provider: ToolProvider;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly pollMs: number;
  readonly maxPolls: number;

  constructor(o: AdapterOptions) {
    this.#fetch = o.fetch ?? ((u, i) => fetch(u, i));
    this.#sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollMs = o.pollMs ?? 5_000;
    this.maxPolls = o.maxPolls ?? 110;
  }

  get manifest(): ToolManifest {
    return PROVIDER_MANIFESTS[this.provider];
  }

  get manifestSha256(): string {
    return toolManifestDigest(this.manifest);
  }

  abstract get configured(): boolean;
  abstract run(tool: string, inputs: Record<string, string>, ctx: ProviderRunContext): Promise<ProviderResult>;

  protected sleep(ms: number): Promise<void> {
    return this.#sleep(ms);
  }

  /** Only the pinned upstream origin is ever contacted; redirects are refused. */
  protected async call(path: string, init: RequestInit): Promise<{ status: number; body: Record<string, unknown> | null }> {
    const base = new URL(this.manifest.upstream);
    const url = new URL(`${base.pathname.replace(/\/$/, "")}${path}`, base.origin);
    if (url.origin !== base.origin) throw new Error("adapter request leaves the provider origin");
    const res = await this.#fetch(url.toString(), { ...init, redirect: "error", signal: init.signal ?? AbortSignal.timeout(30_000) });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const body = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    return { status: res.status, body };
  }

  protected checkInputs(tool: string, inputs: Record<string, string>): ProviderResult | null {
    const t = this.manifest.tools.find((x) => x.name === tool);
    if (!t) return { status: "failed", code: "SERVICE_NOT_ALLOWED", message: `tool ${tool} is not in the pinned manifest` };
    for (const i of t.io.inputs) {
      const v = inputs[i.name];
      if (v === undefined || v.trim() === "") {
        if (i.required) return { status: "failed", code: "INPUT_REQUIRED", message: `${i.name} is required` };
      } else if (v.length > i.maxChars) {
        return { status: "failed", code: "INPUT_TOO_LONG", message: `${i.name} exceeds ${i.maxChars} characters` };
      }
    }
    return null;
  }
}

const MAX_SLIDES = 4;
/** Edits per photo; the original photo is the carousel's first slide. */
const MAX_EDITS = 3;

/** Slide prompts ("Slide 1: …" or "1. …") and an optional "Caption: …" line from a plan. */
export function parseCarouselPlan(text: string): { slides: string[]; caption: string } {
  const slides: string[] = [];
  let caption = "";
  let inCaption = false;
  for (const raw of text.split(/\r?\n/)) {
    const heading = /^\s*#{1,6}\s*(.*)$/.exec(raw);
    if (heading) {
      inCaption = /^caption\b/i.test(heading[1]!.trim());
      continue;
    }
    const line = raw.replace(/^[\s*>-]+/, "").replace(/\*\*/g, "").trim();
    if (line === "") continue;
    const c = /^caption\s*[:\-–]\s*(.+)$/i.exec(line);
    if (c) {
      caption ||= c[1]!.trim().slice(0, 2200);
      continue;
    }
    const m = /^(?:slide\s*\d+|\d+[.)])\s*[:\-–.)]?\s*(.+)$/i.exec(line);
    if (m && m[1]!.trim().length >= 3) slides.push(m[1]!.trim().slice(0, 1000));
    else if (inCaption && caption === "") caption = line.slice(0, 2200);
  }
  return { slides, caption };
}

/** Higgsfield Soul text-to-image: submit, then poll the request status. Server-side key only. */
export class HiggsfieldAdapter extends BaseAdapter {
  readonly provider = "higgsfield" as const;
  /** Seller's own spend cap: images generated per carousel, 2 to 4. */
  readonly maxImages: number;
  constructor(
    private readonly key: { id: string; secret: string } | null,
    o: AdapterOptions & { maxImages?: number } = {},
  ) {
    super(o);
    this.maxImages = Math.min(MAX_SLIDES, Math.max(2, Math.trunc(o.maxImages ?? MAX_SLIDES)));
  }

  get configured(): boolean {
    return this.key !== null;
  }

  async run(tool: string, inputs: Record<string, string>, ctx: ProviderRunContext): Promise<ProviderResult> {
    if (!this.key) return { status: "failed", code: "PROVIDER_UNAVAILABLE", message: PROVIDER_NOT_CONFIGURED };
    const bad = this.checkInputs(tool, inputs);
    if (bad) return bad;
    if (tool === "generate_image") return this.generate(inputs.prompt!, ctx.idempotencyKey);
    if (tool === "edit_carousel_images") return this.editCarousel(inputs.slides!, inputs.photo!, ctx);
    const plan = parseCarouselPlan(inputs.slides!);
    if (plan.slides.length < 2) return { status: "failed", code: "INPUT_REQUIRED", message: "the plan needs at least two \"Slide N:\" lines" };
    const images: string[] = [];
    const ids: string[] = [];
    for (const [i, prompt] of plan.slides.slice(0, this.maxImages).entries()) {
      const r = await this.generate(prompt, `${ctx.idempotencyKey}:${i}`);
      if (r.status !== "succeeded") {
        // Earlier slides were already generated (and billed); none is submitted again.
        if (i === 0) return r;
        return r.status === "uncertain" ? r : { status: "uncertain", message: `slide ${i + 1} failed after ${i} were generated; not resubmitted` };
      }
      images.push(r.artifact.url!);
      ids.push(r.artifact.providerJobId);
    }
    return { status: "succeeded", artifact: { kind: "json", text: JSON.stringify({ images, caption: plan.caption }), providerJobId: ids.join(",") } };
  }

  /** Before-and-after carousel: the original photo, then one Marketing Studio edit per slide prompt. */
  private async editCarousel(slides: string, photo: string, ctx: ProviderRunContext): Promise<ProviderResult> {
    const original = safeMediaUrl(photo.trim());
    if (!original) return { status: "failed", code: "INPUT_REQUIRED", message: "the photo must be an https image URL" };
    const plan = parseCarouselPlan(slides);
    if (plan.slides.length < 1) return { status: "failed", code: "INPUT_REQUIRED", message: "the plan needs at least one \"Slide N:\" line" };
    const images: string[] = [original];
    const ids: string[] = [];
    for (const [i, prompt] of plan.slides.slice(0, Math.min(MAX_EDITS, this.maxImages)).entries()) {
      const r = await this.submitAndPoll("/marketing-studio/image", { prompt, image_urls: [original], aspect_ratio: "9:16", resolution: "1k", enhance_prompt: false }, `${ctx.idempotencyKey}:edit:${i}`);
      if (r.status !== "succeeded") {
        // Earlier edits were already made (and billed); none is submitted again.
        if (i === 0) return r;
        return r.status === "uncertain" ? r : { status: "uncertain", message: `edit ${i + 1} failed after ${i} were made; not resubmitted` };
      }
      images.push(r.artifact.url!);
      ids.push(r.artifact.providerJobId);
    }
    return { status: "succeeded", artifact: { kind: "json", text: JSON.stringify({ images, caption: plan.caption }), providerJobId: ids.join(",") } };
  }

  private generate(prompt: string, idempotencyKey: string): Promise<ProviderResult> {
    return this.submitAndPoll("/higgsfield-ai/soul/v2/standard", { prompt, aspect_ratio: "9:16" }, idempotencyKey);
  }

  /** Submits one image job and polls its status; a job that may have been accepted is never resubmitted. */
  private async submitAndPoll(path: string, payload: Record<string, unknown>, idempotencyKey: string): Promise<ProviderResult> {
    const headers = { authorization: `Key ${this.key!.id}:${this.key!.secret}`, "content-type": "application/json", "idempotency-key": idempotencyKey };
    let submit;
    try {
      submit = await this.call(path, { method: "POST", headers, body: JSON.stringify(payload) });
    } catch (error) {
      return { status: "uncertain", message: `submission outcome unknown: ${(error as Error).name}` };
    }
    if (submit.status >= 500) return { status: "uncertain", message: `submission outcome unknown (HTTP ${submit.status})` };
    const id = submit.body?.request_id;
    if (submit.status >= 400 || typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      return { status: "failed", code: "PROVIDER_REFUSED", message: `provider refused the job (HTTP ${submit.status})` };
    }
    for (let i = 0; i < this.maxPolls; i += 1) {
      await this.sleep(this.pollMs);
      let st;
      try {
        st = await this.call(`/requests/${id}/status`, { method: "GET", headers: { authorization: headers.authorization } });
      } catch {
        continue;
      }
      const status = st.body?.status;
      if (status === "completed") {
        const images = st.body?.images as Array<{ url?: unknown }> | undefined;
        const url = safeMediaUrl(images?.[0]?.url);
        return url ? { status: "succeeded", artifact: { kind: "image_url", url, providerJobId: id } } : { status: "failed", code: "PROVIDER_FAILED", message: "completed without a usable image URL" };
      }
      if (status === "failed" || status === "nsfw" || status === "canceled") return { status: "failed", code: "PROVIDER_FAILED", message: `provider job ${status}` };
    }
    return { status: "uncertain", message: "provider job did not finish in time; it is not resubmitted" };
  }
}

/**
 * The last top-level JSON object in a step input; surrounding text (data notes, fences) is
 * ignored. One forward scan tracks brace depth outside strings, so each candidate is parsed once.
 */
export function lastJsonObject(text: string): Record<string, unknown> | null {
  let found: Record<string, unknown> | null = null;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && depth > 0) inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        try {
          const v = JSON.parse(text.slice(start, i + 1)) as unknown;
          if (typeof v === "object" && v !== null && !Array.isArray(v)) found = v as Record<string, unknown>;
        } catch {
          // not JSON; keep scanning
        }
      }
    }
  }
  return found;
}

/**
 * Zernio TikTok photo carousel, sent to the seller's own TikTok inbox as a draft
 * (tiktokSettings.draft). The creator publishes it in the TikTok app; this adapter never does.
 */
export class ZernioAdapter extends BaseAdapter {
  readonly provider = "zernio" as const;
  constructor(
    private readonly key: { apiKey: string; tiktokAccountId: string } | null,
    o: AdapterOptions = {},
  ) {
    super(o);
  }

  get configured(): boolean {
    return this.key !== null;
  }

  async run(tool: string, inputs: Record<string, string>, ctx: ProviderRunContext): Promise<ProviderResult> {
    if (!this.key) return { status: "failed", code: "PROVIDER_UNAVAILABLE", message: PROVIDER_NOT_CONFIGURED };
    const bad = this.checkInputs(tool, inputs);
    if (bad) return bad;
    const c = lastJsonObject(inputs.carousel!);
    const images = Array.isArray(c?.images) ? (c.images as unknown[]).map(safeMediaUrl) : [];
    if (images.length < 2 || images.length > 35 || images.some((u) => u === null)) {
      return { status: "failed", code: "INPUT_REQUIRED", message: "the carousel needs 2 to 35 https image URLs" };
    }
    const caption = typeof c?.caption === "string" ? c.caption.slice(0, 2200) : "";
    const body = {
      content: caption.slice(0, 90),
      mediaItems: images.map((url) => ({ type: "image", url })),
      platforms: [{ platform: "tiktok", accountId: this.key.tiktokAccountId }],
      tiktokSettings: {
        media_type: "photo",
        photo_cover_index: 0,
        description: caption,
        privacy_level: "SELF_ONLY",
        allow_comment: true,
        auto_add_music: true,
        content_preview_confirmed: true,
        express_consent_given: true,
        draft: true,
      },
      publishNow: true,
    };
    let res;
    try {
      res = await this.call("/posts", {
        method: "POST",
        headers: { authorization: `Bearer ${this.key.apiKey}`, "content-type": "application/json", "idempotency-key": ctx.idempotencyKey },
        body: JSON.stringify(body),
      });
    } catch (error) {
      return { status: "uncertain", message: `draft outcome unknown: ${(error as Error).name}` };
    }
    if (res.status >= 500) return { status: "uncertain", message: `draft outcome unknown (HTTP ${res.status})` };
    const post = res.body?.post as { _id?: unknown; status?: unknown } | undefined;
    const id = typeof post?._id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(post._id) ? post._id : null;
    if (res.status >= 400 || !id || post?.status === "failed") return { status: "failed", code: "PROVIDER_REFUSED", message: `draft refused (HTTP ${res.status})` };
    return {
      status: "succeeded",
      artifact: {
        kind: "draft_post",
        text: JSON.stringify({ platform: "tiktok", zernioPostId: id, slides: images.length, state: "draft in the creator's TikTok inbox; publish it in the TikTok app" }),
        providerJobId: id,
      },
    };
  }
}

/** MakeUGC talking-actor video: generate with the seller's avatar, then poll status. */
export class MakeUgcAdapter extends BaseAdapter {
  readonly provider = "makeugc" as const;
  constructor(
    private readonly key: { apiKey: string; avatarId: string } | null,
    o: AdapterOptions = {},
  ) {
    super(o);
  }

  get configured(): boolean {
    return this.key !== null;
  }

  async run(tool: string, inputs: Record<string, string>, _ctx: ProviderRunContext): Promise<ProviderResult> {
    if (!this.key) return { status: "failed", code: "PROVIDER_UNAVAILABLE", message: PROVIDER_NOT_CONFIGURED };
    const bad = this.checkInputs(tool, inputs);
    if (bad) return bad;
    const headers = { "x-api-key": this.key.apiKey, "content-type": "application/json" };
    let submit;
    try {
      submit = await this.call("/video/generate", { method: "POST", headers, body: JSON.stringify({ avatar_id: this.key.avatarId, voice_script: inputs.script }) });
    } catch (error) {
      return { status: "uncertain", message: `submission outcome unknown: ${(error as Error).name}` };
    }
    if (submit.status >= 500) return { status: "uncertain", message: `submission outcome unknown (HTTP ${submit.status})` };
    const id = (submit.body?.data as { id?: unknown } | undefined)?.id;
    const idText = typeof id === "number" ? String(id) : id;
    if (submit.status >= 400 || typeof idText !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(idText)) {
      return { status: "failed", code: "PROVIDER_REFUSED", message: `provider refused the job (HTTP ${submit.status})` };
    }
    for (let i = 0; i < this.maxPolls; i += 1) {
      await this.sleep(this.pollMs);
      let st;
      try {
        st = await this.call(`/video/status?id=${encodeURIComponent(idText)}`, { method: "GET", headers: { "x-api-key": this.key.apiKey } });
      } catch {
        continue;
      }
      const data = st.body?.data as { status?: unknown; url?: unknown } | undefined;
      if (data?.status === "completed") {
        const url = safeMediaUrl(data.url);
        return url ? { status: "succeeded", artifact: { kind: "video_url", url, providerJobId: idText } } : { status: "failed", code: "PROVIDER_FAILED", message: "completed without a usable video URL" };
      }
      if (data?.status === "failed") return { status: "failed", code: "PROVIDER_FAILED", message: "provider job failed" };
    }
    return { status: "uncertain", message: "provider job did not finish in time; it is not resubmitted" };
  }
}

/** Adapters configured from the seller host's own environment. Keys never leave this process. */
export function providerAdaptersFromEnv(env: NodeJS.ProcessEnv, o: AdapterOptions = {}): Map<ToolProvider, ProviderAdapter> {
  const v = (name: string) => env[name]?.trim() || undefined;
  const hf = v("HIGGSFIELD_API_KEY_ID") && v("HIGGSFIELD_API_KEY_SECRET") ? { id: v("HIGGSFIELD_API_KEY_ID")!, secret: v("HIGGSFIELD_API_KEY_SECRET")! } : null;
  const ugc = v("MAKEUGC_API_KEY") && v("MAKEUGC_AVATAR_ID") ? { apiKey: v("MAKEUGC_API_KEY")!, avatarId: v("MAKEUGC_AVATAR_ID")! } : null;
  const zernio = v("ZERNIO_API_KEY") && v("ZERNIO_TIKTOK_ACCOUNT_ID") ? { apiKey: v("ZERNIO_API_KEY")!, tiktokAccountId: v("ZERNIO_TIKTOK_ACCOUNT_ID")! } : null;
  return new Map<ToolProvider, ProviderAdapter>([
    ["higgsfield", new HiggsfieldAdapter(hf, { ...o, maxImages: Number(v("HIGGSFIELD_MAX_IMAGES") ?? MAX_SLIDES) || MAX_SLIDES })],
    ["makeugc", new MakeUgcAdapter(ugc, o)],
    ["zernio", new ZernioAdapter(zernio, o)],
  ]);
}

/** Public, credential-free view of what this host runs. */
export function providerStatus(adapters: ReadonlyMap<ToolProvider, ProviderAdapter>): Array<{ provider: ToolProvider; manifestSha256: string; status: "configured" | "not_configured"; manifest: ToolManifest }> {
  return [...adapters.values()].map((a) => ({ provider: a.provider, manifestSha256: a.manifestSha256, status: a.configured ? "configured" : "not_configured", manifest: a.manifest }));
}
