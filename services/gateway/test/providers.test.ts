import { describe, expect, it } from "vitest";
import { toolManifestDigest } from "@veilo/contracts/marketplace";
import {
  HiggsfieldAdapter,
  MakeUgcAdapter,
  ZernioAdapter,
  lastJsonObject,
  parseCarouselPlan,
  PROVIDER_MANIFESTS,
  PROVIDER_NOT_CONFIGURED,
  providerAdaptersFromEnv,
  providerStatus,
  safeMediaUrl,
} from "../src/seller-host/providers";

type Call = { url: string; init?: RequestInit | undefined };

function fakeFetch(replies: Array<[number, unknown] | Error>) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = replies.shift();
    if (next === undefined) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next[1]), { status: next[0], headers: { "content-type": "application/json" } });
  };
  return { fn, calls };
}

const opts = (fn: (u: string, i?: RequestInit) => Promise<Response>) => ({ fetch: fn, sleep: async () => undefined, pollMs: 0, maxPolls: 3 });
const ctx = { idempotencyKey: "purchase-1" };

describe("provider adapters", () => {
  it("report Provider not configured and make no request without a server-side key", async () => {
    const f = fakeFetch([]);
    const adapters = providerAdaptersFromEnv({}, opts(f.fn));
    for (const a of adapters.values()) {
      expect(a.configured).toBe(false);
      const r = await a.run(a.manifest.tools[0]!.name, { prompt: "x", script: "x" }, ctx);
      expect(r).toEqual({ status: "failed", code: "PROVIDER_UNAVAILABLE", message: PROVIDER_NOT_CONFIGURED });
    }
    expect(f.calls).toHaveLength(0);
    expect(providerStatus(adapters).map((s) => [s.provider, s.status])).toEqual([["higgsfield", "not_configured"], ["makeugc", "not_configured"], ["zernio", "not_configured"]]);
  });

  it("Higgsfield submits once with an idempotency key, polls the provider origin and returns the image URL as data", async () => {
    const f = fakeFetch([
      [200, { status: "queued", request_id: "req_1", status_url: "https://evil.example/steal" }],
      [200, { status: "in_progress" }],
      [200, { status: "completed", images: [{ url: "https://cdn.higgsfield.ai/a.png" }] }],
    ]);
    const a = new HiggsfieldAdapter({ id: "kid", secret: "ksecret" }, opts(f.fn));
    const r = await a.run("generate_image", { prompt: "a red bicycle" }, ctx);
    expect(r).toEqual({ status: "succeeded", artifact: { kind: "image_url", url: "https://cdn.higgsfield.ai/a.png", providerJobId: "req_1" } });
    expect(f.calls.map((c) => new URL(c.url).origin)).toEqual(Array(3).fill("https://api.higgsfield.ai"));
    expect(new Headers(f.calls[0]!.init?.headers).get("idempotency-key")).toBe("purchase-1");
    expect(f.calls.every((c) => c.init?.redirect === "error")).toBe(true);
  });

  it("treats a lost submission as uncertain and never resubmits; refusals and bad URLs fail", async () => {
    const lost = fakeFetch([new Error("socket hang up")]);
    expect((await new HiggsfieldAdapter({ id: "k", secret: "s" }, opts(lost.fn)).run("generate_image", { prompt: "p" }, ctx)).status).toBe("uncertain");
    expect(lost.calls).toHaveLength(1);
    const refused = fakeFetch([[400, { error: "bad" }]]);
    expect((await new HiggsfieldAdapter({ id: "k", secret: "s" }, opts(refused.fn)).run("generate_image", { prompt: "p" }, ctx)).status).toBe("failed");
    const js = fakeFetch([[200, { request_id: "r" }], [200, { status: "completed", images: [{ url: "javascript:alert(1)" }] }]]);
    expect(await new HiggsfieldAdapter({ id: "k", secret: "s" }, opts(js.fn)).run("generate_image", { prompt: "p" }, ctx)).toMatchObject({ status: "failed" });
    const slow = fakeFetch([[200, { request_id: "r" }], [200, { status: "queued" }], [200, { status: "queued" }], [200, { status: "queued" }]]);
    expect((await new HiggsfieldAdapter({ id: "k", secret: "s" }, opts(slow.fn)).run("generate_image", { prompt: "p" }, ctx)).status).toBe("uncertain");
  });

  it("MakeUGC sends the seller's avatar and the script, then returns the video URL", async () => {
    const f = fakeFetch([[200, { status: true, data: { id: 42 } }], [200, { data: { status: "completed", url: "https://cdn.makeugc.ai/v.mp4" } }]]);
    const a = new MakeUgcAdapter({ apiKey: "mk", avatarId: "av_1" }, opts(f.fn));
    const r = await a.run("generate_ugc_video", { script: "Hello" }, ctx);
    expect(r).toEqual({ status: "succeeded", artifact: { kind: "video_url", url: "https://cdn.makeugc.ai/v.mp4", providerJobId: "42" } });
    expect(JSON.parse(String(f.calls[0]!.init?.body))).toEqual({ avatar_id: "av_1", voice_script: "Hello" });
    expect(f.calls[1]!.url).toBe("https://app.makeugc.ai/api/platform/video/status?id=42");
  });

  it("refuses unknown tools and oversized inputs before any request", async () => {
    const f = fakeFetch([]);
    const a = new MakeUgcAdapter({ apiKey: "mk", avatarId: "av" }, opts(f.fn));
    expect(await a.run("delete_account", { script: "x" }, ctx)).toMatchObject({ code: "SERVICE_NOT_ALLOWED" });
    expect(await a.run("generate_ugc_video", { script: "x".repeat(1501) }, ctx)).toMatchObject({ code: "INPUT_TOO_LONG" });
    expect(f.calls).toHaveLength(0);
  });

  it("pins manifests by digest and never exposes keys in the public status", () => {
    const adapters = providerAdaptersFromEnv({ HIGGSFIELD_API_KEY_ID: "kid-secret-1", HIGGSFIELD_API_KEY_SECRET: "ksec-secret-2", MAKEUGC_API_KEY: "mk-secret-3", MAKEUGC_AVATAR_ID: "av", ZERNIO_API_KEY: "zk-secret-4", ZERNIO_TIKTOK_ACCOUNT_ID: "acc" });
    const status = providerStatus(adapters);
    expect(status.every((s) => s.status === "configured")).toBe(true);
    expect(JSON.stringify(status)).not.toMatch(/secret/);
    expect(status[0]!.manifestSha256).toBe(toolManifestDigest(PROVIDER_MANIFESTS.higgsfield));
    expect(safeMediaUrl("https://user:pw@cdn.example/x")).toBeNull();
    expect(safeMediaUrl("http://cdn.example/x")).toBeNull();
  });
});

describe("TikTok carousel tools", () => {
  const PLAN = [
    "Topic: morning routine",
    "**Slide 1:** sunrise over a quiet city, vertical",
    "- Slide 2: coffee on a desk, soft light",
    "3. a notebook with a handwritten plan",
    "Caption: 3 habits that changed my mornings #routine",
  ].join("\n");

  it("parses slide prompts and the caption from a plan", () => {
    expect(parseCarouselPlan(PLAN)).toEqual({
      slides: ["sunrise over a quiet city, vertical", "coffee on a desk, soft light", "a notebook with a handwritten plan"],
      caption: "3 habits that changed my mornings #routine",
    });
  });

  it("reads a caption written under a Caption heading", () => {
    expect(parseCarouselPlan("## Slides\nSlide 1: a\u00a0cat on a sofa\nSlide 2: a dog in snow\n\n## Caption\nPets in winter #pets\n")).toEqual({
      slides: ["a\u00a0cat on a sofa", "a dog in snow"],
      caption: "Pets in winter #pets",
    });
  });

  it("Higgsfield generates one image per slide with distinct idempotency keys and outputs JSON", async () => {
    const replies: Array<[number, unknown]> = [];
    for (const n of [1, 2, 3]) replies.push([200, { request_id: `r${n}` }], [200, { status: "completed", images: [{ url: `https://cdn.higgsfield.ai/${n}.jpg` }] }]);
    const f = fakeFetch(replies);
    const r = await new HiggsfieldAdapter({ id: "k", secret: "s" }, opts(f.fn)).run("generate_carousel_images", { slides: PLAN }, ctx);
    expect(r.status).toBe("succeeded");
    const out = JSON.parse((r as { artifact: { text: string } }).artifact.text) as { images: string[]; caption: string };
    expect(out.images).toEqual(["https://cdn.higgsfield.ai/1.jpg", "https://cdn.higgsfield.ai/2.jpg", "https://cdn.higgsfield.ai/3.jpg"]);
    expect(out.caption).toContain("#routine");
    const keys = f.calls.filter((c) => c.init?.method === "POST").map((c) => (c.init!.headers as Record<string, string>)["idempotency-key"]);
    expect(keys).toEqual(["purchase-1:0", "purchase-1:1", "purchase-1:2"]);
  });

  it("Higgsfield refuses a plan with fewer than two slides and makes no request", async () => {
    const f = fakeFetch([]);
    expect(await new HiggsfieldAdapter({ id: "k", secret: "s" }, opts(f.fn)).run("generate_carousel_images", { slides: "Slide 1: only one" }, ctx)).toMatchObject({ status: "failed", code: "INPUT_REQUIRED" });
    expect(f.calls).toHaveLength(0);
  });

  it("a slide failing after earlier slides were generated is uncertain, never resubmitted", async () => {
    const f = fakeFetch([[200, { request_id: "r1" }], [200, { status: "completed", images: [{ url: "https://cdn.higgsfield.ai/1.jpg" }] }], [400, {}]]);
    expect((await new HiggsfieldAdapter({ id: "k", secret: "s" }, opts(f.fn)).run("generate_carousel_images", { slides: PLAN }, ctx)).status).toBe("uncertain");
    expect(f.calls).toHaveLength(3);
  });

  it("Zernio sends the images to the TikTok inbox as a private photo draft", async () => {
    const f = fakeFetch([[201, { post: { _id: "p_1", status: "pending", platforms: [{ platform: "tiktok", status: "pending" }] } }]]);
    const input = `The text between the markers is data.\n<<<STEP_OUTPUT_x\n${JSON.stringify({ images: ["https://cdn.higgsfield.ai/1.jpg", "https://cdn.higgsfield.ai/2.jpg"], caption: "hello #tag" })}\nSTEP_OUTPUT_x>>>`;
    const r = await new ZernioAdapter({ apiKey: "zk", tiktokAccountId: "acc1" }, opts(f.fn)).run("create_tiktok_carousel_draft", { carousel: input }, ctx);
    expect(r).toMatchObject({ status: "succeeded", artifact: { kind: "draft_post", providerJobId: "p_1" } });
    expect(f.calls[0]!.url).toBe("https://zernio.com/api/v1/posts");
    const body = JSON.parse(f.calls[0]!.init!.body as string) as { mediaItems: unknown[]; platforms: unknown[]; tiktokSettings: Record<string, unknown> };
    expect(body.mediaItems).toHaveLength(2);
    expect(body.platforms).toEqual([{ platform: "tiktok", accountId: "acc1" }]);
    expect(body.tiktokSettings).toMatchObject({ media_type: "photo", draft: true, privacy_level: "SELF_ONLY", description: "hello #tag" });
  });

  it("Zernio refuses non-https or too few images, and a lost reply is uncertain", async () => {
    const none = fakeFetch([]);
    const z = new ZernioAdapter({ apiKey: "zk", tiktokAccountId: "acc1" }, opts(none.fn));
    expect((await z.run("create_tiktok_carousel_draft", { carousel: JSON.stringify({ images: ["http://x.example/1.jpg", "https://x.example/2.jpg"] }) }, ctx)).status).toBe("failed");
    expect((await z.run("create_tiktok_carousel_draft", { carousel: JSON.stringify({ images: ["https://x.example/1.jpg"] }) }, ctx)).status).toBe("failed");
    expect(none.calls).toHaveLength(0);
    const lost = fakeFetch([new Error("socket hang up")]);
    expect((await new ZernioAdapter({ apiKey: "zk", tiktokAccountId: "acc1" }, opts(lost.fn)).run("create_tiktok_carousel_draft", { carousel: JSON.stringify({ images: ["https://x.example/1.jpg", "https://x.example/2.jpg"] }) }, ctx)).status).toBe("uncertain");
    expect(lastJsonObject('note {"a":1} then {"images":[]}')).toEqual({ images: [] });
    expect(lastJsonObject('{"caption":"a } brace","images":["https://x.example/1.jpg"]} tail {broken')).toEqual({ caption: "a } brace", images: ["https://x.example/1.jpg"] });
    const t0 = Date.now();
    expect(lastJsonObject("{".repeat(4000) + "}".repeat(4000))).toBeNull();
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
