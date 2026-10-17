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
  constructor(
    private readonly key: { id: string; secret: string } | null,
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
    if (tool === "generate_image") return this.generate(inputs.prompt!, ctx.idempotencyKey);
    const plan = parseCarouselPlan(inputs.slides!);
    if (plan.slides.length < 2) return { status: "failed", code: "INPUT_REQUIRED", message: "the plan needs at least two \"Slide N:\" lines" };
    const images: string[] = [];
    const ids: string[] = [];
    for (const [i, prompt] of plan.slides.slice(0, MAX_SLIDES).entries()) {
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

  private async generate(prompt: string, idempotencyKey: string): Promise<ProviderResult> {
    const headers = { authorization: `Key ${this.key!.id}:${this.key!.secret}`, "content-type": "application/json", "idempotency-key": idempotencyKey };
    let submit;
    try {
      submit = await this.call("/higgsfield-ai/soul/v2/standard", { method: "POST", headers, body: JSON.stringify({ prompt, aspect_ratio: "9:16" }) });
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

/** The last JSON object in a step input; earlier text (data notes, fences) is ignored. */
export function lastJsonObject(text: string): Record<string, unknown> | null {
  for (let end = text.lastIndexOf("}"); end >= 0; end = text.lastIndexOf("}", end - 1)) {
    for (let start = text.lastIndexOf("{", end); start >= 0; start = text.lastIndexOf("{", start - 1)) {
      try {
        const v = JSON.parse(text.slice(start, end + 1)) as unknown;
        if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
      } catch {
        // keep widening
      }
    }
  }
  return null;
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
    ["higgsfield", new HiggsfieldAdapter(hf, o)],
    ["makeugc", new MakeUgcAdapter(ugc, o)],
    ["zernio", new ZernioAdapter(zernio, o)],
  ]);
}

/** Public, credential-free view of what this host runs. */
export function providerStatus(adapters: ReadonlyMap<ToolProvider, ProviderAdapter>): Array<{ provider: ToolProvider; manifestSha256: string; status: "configured" | "not_configured"; manifest: ToolManifest }> {
  return [...adapters.values()].map((a) => ({ provider: a.provider, manifestSha256: a.manifestSha256, status: a.configured ? "configured" : "not_configured", manifest: a.manifest }));
}
