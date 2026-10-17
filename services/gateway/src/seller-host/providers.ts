import { toolManifestDigest, type ArtifactKind, type ToolManifest, type ToolProvider } from "@veilo/contracts/marketplace";

/**
 * Pinned provider tool manifests. A listing records the digest at review; the host refuses to
 * quote a listing whose digest differs from the manifest it runs, so an adapter change disables
 * the tool until it is reviewed again. Endpoints follow each provider's official API docs
 * (checked 2026-10-17); they have not been exercised against the live providers.
 */
export const PROVIDER_MANIFESTS: Readonly<Record<ToolProvider, ToolManifest>> = {
  higgsfield: {
    provider: "higgsfield",
    adapterVersion: "1.0.0",
    upstream: "https://api.higgsfield.ai",
    tools: [
      {
        name: "generate_image",
        effect: "read_only",
        io: { inputs: [{ name: "prompt", kind: "text", required: true, maxChars: 2000 }], output: { kind: "image_url" } },
      },
    ],
  },
  makeugc: {
    provider: "makeugc",
    adapterVersion: "1.0.0",
    upstream: "https://app.makeugc.ai/api/platform",
    tools: [
      {
        name: "generate_ugc_video",
        effect: "read_only",
        io: { inputs: [{ name: "script", kind: "text", required: true, maxChars: 1500 }], output: { kind: "video_url" } },
      },
    ],
  },
  zernio: {
    provider: "zernio",
    adapterVersion: "1.0.0",
    upstream: "https://zernio.com/api/v1",
    tools: [
      {
        name: "create_draft",
        effect: "draft_external",
        io: { inputs: [{ name: "text", kind: "text", required: true, maxChars: 2000 }], output: { kind: "draft_post" } },
      },
    ],
  },
};

export const PROVIDER_NOT_CONFIGURED = "Provider not configured";

export type ProviderResult =
  | { status: "succeeded"; artifact: { kind: ArtifactKind; url: string; providerJobId: string } }
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
    let body: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(text) as unknown;
      body = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
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

/** Higgsfield text-to-image: submit, then poll the request status. Server-side key only. */
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
    const headers = { authorization: `Key ${this.key.id}:${this.key.secret}`, "content-type": "application/json", "idempotency-key": ctx.idempotencyKey };
    let submit;
    try {
      submit = await this.call("/higgsfield-ai/soul/v2/standard", { method: "POST", headers, body: JSON.stringify({ prompt: inputs.prompt }) });
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
  return new Map<ToolProvider, ProviderAdapter>([
    ["higgsfield", new HiggsfieldAdapter(hf, o)],
    ["makeugc", new MakeUgcAdapter(ugc, o)],
  ]);
}

/** Public, credential-free view of what this host runs. */
export function providerStatus(adapters: ReadonlyMap<ToolProvider, ProviderAdapter>): Array<{ provider: ToolProvider; manifestSha256: string; status: "configured" | "not_configured"; manifest: ToolManifest }> {
  return [...adapters.values()].map((a) => ({ provider: a.provider, manifestSha256: a.manifestSha256, status: a.configured ? "configured" : "not_configured", manifest: a.manifest }));
}
