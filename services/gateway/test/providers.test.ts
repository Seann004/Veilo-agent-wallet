import { describe, expect, it } from "vitest";
import { toolManifestDigest } from "@veilo/contracts/marketplace";
import {
  HiggsfieldAdapter,
  MakeUgcAdapter,
  refusalReason,
  RenderedMedia,
  SlidesAdapter,
  ZernioAdapter,
  ZernioPublishAdapter,
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
const CREATOR_INFO = (levels: string[]) => ({ creator: { canPostMore: true }, privacyLevels: levels.map((value) => ({ value })) });

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
    expect(providerStatus(adapters).map((s) => [s.provider, s.status])).toEqual([
      ["higgsfield", "not_configured"],
      ["makeugc", "not_configured"],
      ["zernio", "not_configured"],
      ["slides", "not_configured"],
      ["zernio_publish", "not_configured"],
    ]);
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
    const adapters = providerAdaptersFromEnv({ HIGGSFIELD_API_KEY_ID: "kid-secret-1", HIGGSFIELD_API_KEY_SECRET: "ksec-secret-2", MAKEUGC_API_KEY: "mk-secret-3", MAKEUGC_AVATAR_ID: "av", ZERNIO_API_KEY: "zk-secret-4", ZERNIO_TIKTOK_ACCOUNT_ID: "acc", ZERNIO_PUBLISH_MODE: "publish" });
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

  it("the seller's image cap limits how many slides are generated", async () => {
    const f = fakeFetch([[200, { request_id: "r1" }], [200, { status: "completed", images: [{ url: "https://cdn.higgsfield.ai/1.jpg" }] }], [200, { request_id: "r2" }], [200, { status: "completed", images: [{ url: "https://cdn.higgsfield.ai/2.jpg" }] }]]);
    const a = providerAdaptersFromEnv({ HIGGSFIELD_API_KEY_ID: "k", HIGGSFIELD_API_KEY_SECRET: "s", HIGGSFIELD_MAX_IMAGES: "2" }, opts(f.fn)).get("higgsfield")!;
    const r = await a.run("generate_carousel_images", { slides: PLAN }, ctx);
    expect(JSON.parse((r as { artifact: { text: string } }).artifact.text).images).toHaveLength(2);
    expect(f.calls.filter((c) => c.init?.method === "POST")).toHaveLength(2);
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

  it("Higgsfield edits the owner's photo once per slide; only its own images reach the carousel", async () => {
    const photo = "https://images.example/product.jpg";
    const replies: Array<[number, unknown]> = [];
    for (const n of [1, 2, 3]) replies.push([200, { request_id: `e${n}` }], [200, { status: "completed", images: [{ url: `https://cdn.higgsfield.ai/edit${n}.jpg` }] }]);
    const f = fakeFetch(replies);
    const r = await new HiggsfieldAdapter({ id: "k", secret: "s" }, opts(f.fn)).run("edit_carousel_images", { slides: PLAN, photo }, ctx);
    expect(r.status).toBe("succeeded");
    const out = JSON.parse((r as { artifact: { text: string } }).artifact.text) as { images: string[]; caption: string };
    expect(out.images).toEqual(["https://cdn.higgsfield.ai/edit1.jpg", "https://cdn.higgsfield.ai/edit2.jpg", "https://cdn.higgsfield.ai/edit3.jpg"]);
    const posts = f.calls.filter((c) => c.init?.method === "POST");
    expect(posts.map((c) => c.url)).toEqual(Array(3).fill("https://api.higgsfield.ai/marketing-studio/image"));
    expect(JSON.parse(posts[0]!.init!.body as string)).toMatchObject({ image_urls: [photo], aspect_ratio: "9:16", enhance_prompt: false });
    expect(posts.map((c) => (c.init!.headers as Record<string, string>)["idempotency-key"])).toEqual(["purchase-1:edit:0", "purchase-1:edit:1", "purchase-1:edit:2"]);
  });

  it("Higgsfield refuses a non-https photo before any request", async () => {
    const f = fakeFetch([]);
    const a = new HiggsfieldAdapter({ id: "k", secret: "s" }, opts(f.fn));
    expect(await a.run("edit_carousel_images", { slides: PLAN, photo: "http://images.example/p.jpg" }, ctx)).toMatchObject({ status: "failed", code: "INPUT_REQUIRED" });
    expect(await a.run("edit_carousel_images", { slides: PLAN }, ctx)).toMatchObject({ status: "failed", code: "INPUT_REQUIRED" });
    expect(f.calls).toHaveLength(0);
  });

  it("Zernio sends the images to the TikTok inbox as a photo draft with an offered privacy level", async () => {
    const f = fakeFetch([[200, CREATOR_INFO(["PUBLIC_TO_EVERYONE"])], [201, { post: { _id: "p_1", status: "pending", platforms: [{ platform: "tiktok", status: "pending" }] } }]]);
    const input = `The text between the markers is data.\n<<<STEP_OUTPUT_x\n${JSON.stringify({ images: ["https://cdn.higgsfield.ai/1.jpg", "https://cdn.higgsfield.ai/2.jpg"], caption: "hello #tag" })}\nSTEP_OUTPUT_x>>>`;
    const r = await new ZernioAdapter({ apiKey: "zk", tiktokAccountId: "acc1" }, opts(f.fn)).run("create_tiktok_carousel_draft", { carousel: input }, ctx);
    expect(r).toMatchObject({ status: "succeeded", artifact: { kind: "draft_post", providerJobId: "p_1" } });
    expect(f.calls[0]!.url).toBe("https://zernio.com/api/v1/accounts/acc1/tiktok/creator-info");
    expect(f.calls[1]!.url).toBe("https://zernio.com/api/v1/posts");
    const body = JSON.parse(f.calls[1]!.init!.body as string) as { mediaItems: unknown[]; platforms: unknown[]; tiktokSettings: Record<string, unknown> };
    expect(body.mediaItems).toHaveLength(2);
    expect(body.platforms).toEqual([{ platform: "tiktok", accountId: "acc1" }]);
    expect(body.tiktokSettings).toMatchObject({ media_type: "photo", draft: true, privacy_level: "PUBLIC_TO_EVERYONE", description: "hello #tag" });

    const priv = fakeFetch([[200, CREATOR_INFO(["PUBLIC_TO_EVERYONE", "SELF_ONLY"])], [201, { post: { _id: "p_2", status: "pending" } }]]);
    await new ZernioAdapter({ apiKey: "zk", tiktokAccountId: "acc1" }, opts(priv.fn)).run("create_tiktok_carousel_draft", { carousel: input }, ctx);
    expect(JSON.parse(priv.calls[1]!.init!.body as string).tiktokSettings.privacy_level).toBe("SELF_ONLY");
  });

  it("adds the seller's style to every generated image prompt, within the prompt bound", async () => {
    const f = fakeFetch([[200, { request_id: "r1" }], [200, { status: "completed", images: [{ url: "https://cdn.example/1.png" }] }]]);
    await new HiggsfieldAdapter({ id: "k", secret: "s" }, { ...opts(f.fn), style: "  matte charcoal,\n terracotta accent " }).run("generate_image", { prompt: "a mug" }, ctx);
    expect(JSON.parse(f.calls[0]!.init!.body as string).prompt).toBe("a mug\n\nStyle: matte charcoal, terracotta accent");
    const long = fakeFetch([[200, { request_id: "r2" }], [200, { status: "completed", images: [{ url: "https://cdn.example/2.png" }] }]]);
    await new HiggsfieldAdapter({ id: "k", secret: "s" }, { ...opts(long.fn), style: "s".repeat(900) }).run("generate_image", { prompt: "p".repeat(2000) }, ctx);
    expect((JSON.parse(long.calls[0]!.init!.body as string).prompt as string).length).toBeLessThanOrEqual(2000);
  });

  it("names the provider's own refusal reason, bounded and as plain text", async () => {
    expect(refusalReason({ detail: "not_enough_credits" })).toBe(": not_enough_credits");
    expect(refusalReason({ detail: "<script>alert(1)</script>" })).toBe("");
    expect(refusalReason({ post: { platforms: [{ errorMessage: "TikTok failed (code 40002):\nupdate the app" }] } })).toBe(": TikTok failed (code 40002): update the app");
    expect(refusalReason(null)).toBe("");
    const f = fakeFetch([[403, { detail: "not_enough_credits" }]]);
    expect(await new HiggsfieldAdapter({ id: "k", secret: "s" }, opts(f.fn)).run("generate_image", { prompt: "a mug" }, ctx)).toMatchObject({ status: "failed", message: "provider refused the job (HTTP 403): not_enough_credits" });
  });

  it("Zernio sends nothing when the TikTok account check fails or the account cannot post", async () => {
    const two = JSON.stringify({ images: ["https://x.example/1.jpg", "https://x.example/2.jpg"] });
    for (const reply of [[401, { error: "unauthorized" }], [200, { privacyLevels: [] }], new Error("socket hang up")] as Array<[number, unknown] | Error>) {
      const f = fakeFetch([reply]);
      expect(await new ZernioAdapter({ apiKey: "zk", tiktokAccountId: "acc1" }, opts(f.fn)).run("create_tiktok_carousel_draft", { carousel: two }, ctx)).toMatchObject({ status: "failed", code: "PROVIDER_UNAVAILABLE" });
      expect(f.calls).toHaveLength(1);
    }
    const full = fakeFetch([[200, { ...CREATOR_INFO(["PUBLIC_TO_EVERYONE"]), creator: { canPostMore: false } }]]);
    expect(await new ZernioAdapter({ apiKey: "zk", tiktokAccountId: "acc1" }, opts(full.fn)).run("create_tiktok_carousel_draft", { carousel: two }, ctx)).toMatchObject({ status: "failed", code: "PROVIDER_REFUSED" });
    expect(full.calls).toHaveLength(1);
  });

  it("Zernio refuses non-https or too few images, and a lost reply is uncertain", async () => {
    const none = fakeFetch([]);
    const z = new ZernioAdapter({ apiKey: "zk", tiktokAccountId: "acc1" }, opts(none.fn));
    expect((await z.run("create_tiktok_carousel_draft", { carousel: JSON.stringify({ images: ["http://x.example/1.jpg", "https://x.example/2.jpg"] }) }, ctx)).status).toBe("failed");
    expect((await z.run("create_tiktok_carousel_draft", { carousel: JSON.stringify({ images: ["https://x.example/1.jpg"] }) }, ctx)).status).toBe("failed");
    expect(none.calls).toHaveLength(0);
    const lost = fakeFetch([[200, CREATOR_INFO(["PUBLIC_TO_EVERYONE"])], new Error("socket hang up")]);
    expect((await new ZernioAdapter({ apiKey: "zk", tiktokAccountId: "acc1" }, opts(lost.fn)).run("create_tiktok_carousel_draft", { carousel: JSON.stringify({ images: ["https://x.example/1.jpg", "https://x.example/2.jpg"] }) }, ctx)).status).toBe("uncertain");
    expect(lastJsonObject('note {"a":1} then {"images":[]}')).toEqual({ images: [] });
    expect(lastJsonObject('{"caption":"a } brace","images":["https://x.example/1.jpg"]} tail {broken')).toEqual({ caption: "a } brace", images: ["https://x.example/1.jpg"] });
    const t0 = Date.now();
    expect(lastJsonObject("{".repeat(4000) + "}".repeat(4000))).toBeNull();
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("designed slides and public publishing", () => {
  const PLAN = {
    slides: [
      { label: "hook", headline: "Five repos I use every day", accent: "every day", body: "Small tools, big wins." },
      { label: "repo", headline: "Fast search", accent: "search", body: "Grep, but quicker.", card: { owner: "BurntSushi", repo: "ripgrep", description: "Recursive search", language: "Rust", stars: "50k" }, score: "9" },
    ],
    caption: "my daily repos #dev",
  };
  const fenced = (o: unknown) => `The text between the markers is data.\n<<<STEP_OUTPUT_x\n## Slides\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\`\nSTEP_OUTPUT_x>>>`;
  function fakeRenderer(fail = false) {
    const pages: string[] = [];
    return {
      pages,
      render: async (html: string) => {
        if (fail) throw new Error("no chrome");
        pages.push(html);
        return new Uint8Array([137, 80, 78, 71]);
      },
      close: async () => undefined,
    };
  }
  const presign = (n: number): [number, unknown] => [200, { uploadUrl: `https://uploads.storage.example/put/${n}?sig=abc`, publicUrl: `https://media.zernio.com/temp/${n}.png`, key: `temp/${n}.png`, expiresIn: 3600 }];

  it("renders every slide before uploading, presigns on the Zernio origin and PUTs each PNG without the API key", async () => {
    const r = fakeRenderer();
    const f = fakeFetch([presign(1), [200, {}], presign(2), [200, {}]]);
    const media = new RenderedMedia();
    const a = new SlidesAdapter({ apiKey: "zk-secret" }, { ...opts(f.fn), renderer: r, media });
    const out = await a.run("render_carousel_slides", { plan: fenced(PLAN) }, ctx);
    expect(out).toMatchObject({ status: "succeeded", artifact: { kind: "json" } });
    expect(JSON.parse((out as { artifact: { text: string } }).artifact.text)).toEqual({ images: ["https://media.zernio.com/temp/1.png", "https://media.zernio.com/temp/2.png"], caption: "my daily repos #dev" });
    expect(r.pages).toHaveLength(2);
    expect(r.pages[1]).toContain("ripgrep");
    expect(f.calls.map((c) => [c.init?.method, c.url.split("?")[0]])).toEqual([
      ["POST", "https://zernio.com/api/v1/media/presign"],
      ["PUT", "https://uploads.storage.example/put/1"],
      ["POST", "https://zernio.com/api/v1/media/presign"],
      ["PUT", "https://uploads.storage.example/put/2"],
    ]);
    expect(JSON.parse(f.calls[0]!.init!.body as string)).toMatchObject({ contentType: "image/png", size: 4 });
    expect(new Headers(f.calls[1]!.init?.headers).get("authorization")).toBeNull();
    expect(f.calls.every((c) => c.init?.redirect === "error")).toBe(true);
    expect(media.has("https://media.zernio.com/temp/2.png")).toBe(true);
  });

  it("uploads nothing when a slide fails to render or the plan is unusable", async () => {
    const f = fakeFetch([]);
    expect(await new SlidesAdapter({ apiKey: "zk" }, { ...opts(f.fn), renderer: fakeRenderer(true) }).run("render_carousel_slides", { plan: fenced(PLAN) }, ctx)).toMatchObject({ status: "failed", code: "PROVIDER_UNAVAILABLE" });
    const a = new SlidesAdapter({ apiKey: "zk" }, { ...opts(f.fn), renderer: fakeRenderer() });
    expect(await a.run("render_carousel_slides", { plan: fenced({ slides: [PLAN.slides[0]] }) }, ctx)).toMatchObject({ status: "failed", code: "INPUT_REQUIRED" });
    expect(await a.run("render_carousel_slides", { plan: "no json here" }, ctx)).toMatchObject({ status: "failed", code: "INPUT_REQUIRED" });
    expect(f.calls).toHaveLength(0);
  });

  it("refuses a presign whose public URL is not Zernio media, and a failed PUT", async () => {
    const bad = fakeFetch([[200, { uploadUrl: "https://uploads.storage.example/put", publicUrl: "https://evil.example/x.png" }]]);
    expect(await new SlidesAdapter({ apiKey: "zk" }, { ...opts(bad.fn), renderer: fakeRenderer() }).run("render_carousel_slides", { plan: fenced(PLAN) }, ctx)).toMatchObject({ status: "failed", code: "PROVIDER_REFUSED" });
    const put = fakeFetch([presign(1), [403, {}]]);
    expect(await new SlidesAdapter({ apiKey: "zk" }, { ...opts(put.fn), renderer: fakeRenderer() }).run("render_carousel_slides", { plan: fenced(PLAN) }, ctx)).toMatchObject({ status: "failed", code: "PROVIDER_REFUSED" });
    expect(put.calls).toHaveLength(2);
  });

  it("publish mode is off by default and the draft tool never changes with it", () => {
    const env = { ZERNIO_API_KEY: "zk", ZERNIO_TIKTOK_ACCOUNT_ID: "acc" };
    expect(providerAdaptersFromEnv(env).get("zernio_publish")!.configured).toBe(false);
    expect(providerAdaptersFromEnv({ ...env, ZERNIO_PUBLISH_MODE: "publish" }).get("zernio_publish")!.configured).toBe(true);
    expect(providerAdaptersFromEnv({ ...env, ZERNIO_PUBLISH_MODE: "publish" }).get("zernio")!.manifest.tools[0]!.effect).toBe("draft_external");
    expect(providerAdaptersFromEnv({ ...env, SLIDES_RENDERER: "off" }).get("slides")!.configured).toBe(false);
    expect(() => providerAdaptersFromEnv({ ...env, ZERNIO_PUBLISH_MODE: "live" })).toThrow(/draft or publish/);
  });

  it("publishes publicly without a draft flag, and only images this host rendered", async () => {
    const media = new RenderedMedia();
    const imgs = ["https://media.zernio.com/temp/1.png", "https://media.zernio.com/temp/2.png"];
    const carousel = fenced({ images: imgs, caption: "my daily repos #dev" });
    const none = fakeFetch([]);
    expect(await new ZernioPublishAdapter({ apiKey: "zk", tiktokAccountId: "acc1" }, media, opts(none.fn)).run("publish_tiktok_carousel", { carousel }, ctx)).toMatchObject({ status: "failed", code: "INPUT_REFUSED" });
    expect(none.calls).toHaveLength(0);

    for (const u of imgs) media.add(u);
    const f = fakeFetch([[200, CREATOR_INFO(["PUBLIC_TO_EVERYONE", "SELF_ONLY"])], [201, { post: { _id: "p_9", status: "published" } }]]);
    const r = await new ZernioPublishAdapter({ apiKey: "zk", tiktokAccountId: "acc1" }, media, opts(f.fn)).run("publish_tiktok_carousel", { carousel }, ctx);
    expect(r).toMatchObject({ status: "succeeded", artifact: { kind: "draft_post", providerJobId: "p_9" } });
    expect(JSON.parse((r as { artifact: { text: string } }).artifact.text).state).toBe("published publicly on TikTok");
    const body = JSON.parse(f.calls[1]!.init!.body as string) as { publishNow: boolean; tiktokSettings: Record<string, unknown> };
    expect(body.publishNow).toBe(true);
    expect(body.tiktokSettings).not.toHaveProperty("draft");
    expect(body.tiktokSettings).toMatchObject({ media_type: "photo", privacy_level: "PUBLIC_TO_EVERYONE", content_preview_confirmed: true, express_consent_given: true, allow_duet: false, allow_stitch: false });
  });

  it("publishing refuses an account without public posting and maps 207 outcomes", async () => {
    const media = new RenderedMedia();
    const imgs = ["https://media.zernio.com/temp/1.png", "https://media.zernio.com/temp/2.png"];
    for (const u of imgs) media.add(u);
    const carousel = JSON.stringify({ images: imgs, caption: "c" });
    const run = (replies: Array<[number, unknown] | Error>) => {
      const f = fakeFetch(replies);
      return { f, p: new ZernioPublishAdapter({ apiKey: "zk", tiktokAccountId: "acc1" }, media, opts(f.fn)).run("publish_tiktok_carousel", { carousel }, ctx) };
    };
    const priv = run([[200, CREATOR_INFO(["SELF_ONLY"])]]);
    expect(await priv.p).toMatchObject({ status: "failed", code: "PROVIDER_REFUSED" });
    expect(priv.f.calls).toHaveLength(1);
    expect(await run([[200, CREATOR_INFO(["PUBLIC_TO_EVERYONE"])], [207, { post: { _id: "p_1", status: "failed", platforms: [{ errorMessage: "TikTok refused" }] } }]]).p).toMatchObject({ status: "failed", code: "PROVIDER_REFUSED" });
    const queued = await run([[200, CREATOR_INFO(["PUBLIC_TO_EVERYONE"])], [207, { post: { _id: "p_2", status: "scheduled" } }]]).p;
    expect(queued.status).toBe("succeeded");
    expect(JSON.parse((queued as { artifact: { text: string } }).artifact.text).state).toMatch(/retrying/);
    expect((await run([[200, CREATOR_INFO(["PUBLIC_TO_EVERYONE"])], [207, { post: { _id: "p_3", status: "partial" } }]]).p).status).toBe("uncertain");
    expect((await run([[200, CREATOR_INFO(["PUBLIC_TO_EVERYONE"])], new Error("socket hang up")]).p).status).toBe("uncertain");
  });

  it("forgets rendered media after its time and stays bounded", () => {
    let now = 0;
    const m = new RenderedMedia(1_000, 2, () => now);
    m.add("a");
    m.add("b");
    m.add("c");
    expect(m.has("a")).toBe(false);
    expect(m.has("c")).toBe(true);
    now = 2_000;
    expect(m.has("c")).toBe(false);
  });
});
