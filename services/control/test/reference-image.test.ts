import { afterEach, describe, expect, it } from "vitest";
import { loadReferenceImage, parseReferenceImage, REFERENCE_IMAGE_MAX_BYTES, saveReferenceImage } from "../src/agents/attachments";
import { AiService, cleanStyleText, REFERENCE_STYLE_PROMPT } from "../src/ai/service";
import { ProviderKeyVault } from "../src/ai/vault";
import { getAgent } from "../src/ledger/workspace";
import { activateDefaults, createEnv, intentTask, type TestEnv } from "./helpers";

let env: TestEnv;
afterEach(() => env?.cleanup());

const KEY = "sk-or-v1-0123456789abcdef";
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = Buffer.concat([PNG_HEAD, Buffer.alloc(40, 7)]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(20, 2)]);
const dataUrl = (mime: string, b: Buffer) => `data:${mime};base64,${b.toString("base64")}`;

describe("reference image validation", () => {
  it("accepts PNG, JPEG and WebP whose bytes match the declared type", () => {
    expect(parseReferenceImage(dataUrl("image/png", png))).toMatchObject({ mime: "image/png" });
    expect(parseReferenceImage(dataUrl("image/jpeg", jpeg)).bytes.equals(jpeg)).toBe(true);
    expect(parseReferenceImage(dataUrl("image/webp", webp))).toMatchObject({ mime: "image/webp" });
  });

  it.each([
    ["a GIF", dataUrl("image/gif", Buffer.from("GIF89a....")), /PNG, JPEG or WebP/],
    ["an SVG", dataUrl("image/svg+xml", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), /PNG, JPEG or WebP/],
    ["a URL-encoded SVG", "data:image/svg+xml,%3Csvg%3E%3C/svg%3E", /PNG, JPEG or WebP/],
    ["a remote URL", "https://example.com/a.png", /data URL/],
    ["a PNG labelled as JPEG", dataUrl("image/jpeg", png), /not a JPEG image/],
    ["an SVG labelled as PNG", dataUrl("image/png", Buffer.from("<svg/>")), /not a PNG image/],
    ["broken base64", "data:image/png;base64,iVBOR!!!", /PNG, JPEG or WebP/],
    ["unpadded base64", "data:image/png;base64,iVBORw0KGgoAAA", /malformed/],
    ["a non-string", 42, /data URL/],
    ["an oversized image", dataUrl("image/png", Buffer.concat([PNG_HEAD, Buffer.alloc(REFERENCE_IMAGE_MAX_BYTES)])), /larger than 1.5 MB/],
  ])("refuses %s", (_label, value, why) => {
    expect(() => parseReferenceImage(value)).toThrow(why);
  });

  it("keeps an image at exactly the size limit", () => {
    const max = Buffer.concat([PNG_HEAD, Buffer.alloc(REFERENCE_IMAGE_MAX_BYTES - PNG_HEAD.length)]);
    expect(parseReferenceImage(dataUrl("image/png", max)).bytes.length).toBe(REFERENCE_IMAGE_MAX_BYTES);
  });
});

describe("cleanStyleText", () => {
  it("keeps hex colours and drops markup, links, control characters and excess length", () => {
    const out = cleanStyleText("**Warm** <b>terracotta</b> #c97b5a background,\u0007 see https://evil.example/x and www.evil.example; `bold` sans serif\n\n# heading");
    expect(out).toContain("#c97b5a");
    expect(out).not.toMatch(/<|>|\*|`|https?:|evil\.example|\n/);
    expect(out).not.toContain("\u0007");
    expect(cleanStyleText("a ".repeat(300)).length).toBeLessThanOrEqual(200);
  });
});

describe("describe_reference", () => {
  function setup(reply: () => Response) {
    env = createEnv();
    activateDefaults(env);
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return reply();
    };
    const ai = new AiService(env.ledger, ProviderKeyVault.ephemeral(), fetchImpl);
    const agent = getAgent(env.ledger, env.agents.Prince.id)!;
    const taskId = intentTask(env, agent.id, "ref");
    env.db.prepare("UPDATE task SET state = 'running' WHERE id = ?").run(taskId);
    return { ai, agent, taskId, calls };
  }
  const ok = (text: string) => () => new Response(JSON.stringify({ model: "glm-5.3-flash", choices: [{ message: { content: text } }] }), { status: 200 });

  it("sends the image with the fixed prompt on an OpenAI-compatible provider and returns clean, labelled text", async () => {
    const { ai, agent, taskId, calls } = setup(ok(`Cream #f4efe6 background, terracotta #c97b5a accents, <i>bold</i> serif headings. Visit https://x.example/y ${"and more ".repeat(40)}`));
    ai.set(env.ws.id, "owner", { provider: "openai_compatible", baseUrl: "https://api.z.ai/api/coding/paas/v4", apiKey: KEY, model: "glm-5.3-flash" });
    saveReferenceImage(env.ledger, taskId, parseReferenceImage(dataUrl("image/png", png)));

    const r = await ai.describeReference(agent, { taskId });
    expect(r).toMatchObject({ untrusted: true, model: "glm-5.3-flash" });
    const style = r.style as string;
    expect(style.length).toBeLessThanOrEqual(200);
    expect(style).toMatch(/^Cream #f4efe6 background, terracotta #c97b5a accents, bold serif headings\./);
    expect(style).not.toMatch(/<|https?:|x\.example/);

    const body = calls[0]!.body as { messages: Array<{ role: string; content: unknown }>; thinking?: unknown };
    expect(calls[0]!.url).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions");
    expect(body.messages[0]).toEqual({ role: "system", content: REFERENCE_STYLE_PROMPT });
    expect(body.messages[1]!.content).toEqual([
      { type: "text", text: expect.any(String) },
      { type: "image_url", image_url: { url: dataUrl("image/png", png) } },
    ]);
    // Z.ai rejects disabling thinking on this call, so nothing is sent for it.
    expect(body.thinking).toBeUndefined();
    expect(Number(env.db.prepare("SELECT ai_calls FROM task WHERE id = ?").pluck().get(taskId))).toBe(1);
  });

  it("uses an Anthropic base64 image block", async () => {
    const { ai, agent, taskId, calls } = setup(() => new Response(JSON.stringify({ model: "claude-sonnet-5-5", content: [{ type: "text", text: "Dark navy, white sans serif." }] }), { status: 200 }));
    ai.set(env.ws.id, "owner", { provider: "anthropic", apiKey: KEY, model: "claude-sonnet-5-5" });
    saveReferenceImage(env.ledger, taskId, parseReferenceImage(dataUrl("image/jpeg", jpeg)));
    expect((await ai.describeReference(agent, { taskId })).style).toBe("Dark navy, white sans serif.");
    const body = calls[0]!.body as { system: string; messages: Array<{ content: unknown }> };
    expect(body.system).toBe(REFERENCE_STYLE_PROMPT);
    expect(body.messages[0]!.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } },
      { type: "text", text: expect.any(String) },
    ]);
  });

  it("explains a provider that cannot read images, and refuses a task without an image before counting a call", async () => {
    const { ai, agent, taskId, calls } = setup(() => new Response("{}", { status: 400 }));
    ai.set(env.ws.id, "owner", { provider: "openai", apiKey: KEY, model: "text-only" });
    await expect(ai.describeReference(agent, { taskId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls).toHaveLength(0);
    saveReferenceImage(env.ledger, taskId, parseReferenceImage(dataUrl("image/webp", webp)));
    await expect(ai.describeReference(agent, { taskId })).rejects.toMatchObject({ code: "INVALID_REQUEST", message: expect.stringMatching(/can't read images/) });
    expect(Number(env.db.prepare("SELECT ai_calls FROM task WHERE id = ?").pluck().get(taskId))).toBe(1);
    expect(loadReferenceImage(env.ledger, taskId)?.mime).toBe("image/webp");
  });

  it("stops with the agent's work authority and another agent cannot read the image", async () => {
    const { ai, agent, taskId } = setup(ok("x"));
    ai.set(env.ws.id, "owner", { provider: "openai", apiKey: KEY, model: "m" });
    saveReferenceImage(env.ledger, taskId, parseReferenceImage(dataUrl("image/png", png)));
    const other = getAgent(env.ledger, env.agents.Mira.id)!;
    await expect(ai.describeReference(other, { taskId })).rejects.toMatchObject({ code: "POLICY_DENIED" });
    env.db.prepare("UPDATE agent SET status = 'paused' WHERE id = ?").run(agent.id);
    await expect(ai.describeReference({ ...agent, status: "paused" }, { taskId })).rejects.toHaveProperty("code");
    expect(Number(env.db.prepare("SELECT ai_calls FROM task WHERE id = ?").pluck().get(taskId))).toBe(0);
  });
});
