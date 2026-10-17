import { afterEach, describe, expect, it } from "vitest";
import { AiService, MAX_AI_CALLS_PER_TASK } from "../src/ai/service";
import { ProviderKeyVault } from "../src/ai/vault";
import { ControlError } from "../src/errors";
import { getAgent } from "../src/ledger/workspace";
import { activateDefaults, createEnv, intentTask, type TestEnv } from "./helpers";

let env: TestEnv;
afterEach(() => env?.cleanup());

const KEY = "sk-or-v1-0123456789abcdef";

/** Records each provider request and answers with a scripted completion. */
function fakeProvider(reply: (url: string, body: Record<string, unknown>) => unknown) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url, headers: init?.headers as Record<string, string>, body });
    return new Response(JSON.stringify(reply(url, body)), { status: 200 });
  };
  return { calls, fetchImpl };
}

/** A task the runner has claimed: model calls are allowed only while it runs. */
function runningTask(e: TestEnv, agentId: string, key: string): string {
  const id = intentTask(e, agentId, key);
  e.db.prepare("UPDATE task SET state = 'running' WHERE id = ?").run(id);
  return id;
}

const openaiReply = (text: string) => ({ model: "deepseek/deepseek-v4-flash", choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 3 } });

describe("bring your own model key", () => {
  it("seals the key per workspace and never returns it", () => {
    const vault = ProviderKeyVault.ephemeral();
    const sealed = vault.seal("ws-1", KEY);
    expect(sealed).not.toContain(KEY);
    expect(vault.open("ws-1", sealed)).toBe(KEY);
    expect(() => vault.open("ws-2", sealed)).toThrow();
    expect(JSON.stringify({ vault })).not.toContain(KEY);

    env = createEnv();
    const ai = new AiService(env.ledger, vault);
    const view = ai.set(env.ws.id, "owner", { provider: "openrouter", apiKey: KEY, model: "deepseek/deepseek-v4-flash" });
    expect(view).toMatchObject({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", keyHint: "…cdef" });
    expect(JSON.stringify(view)).not.toContain(KEY);
    const stored = env.db.prepare("SELECT key_ciphertext FROM ai_provider").pluck().get() as string;
    expect(stored).not.toContain(KEY);
    const audit = env.db.prepare("SELECT group_concat(details_json) FROM audit_event").pluck().get() as string;
    expect(audit).not.toContain(KEY);
  });

  it("plans and runs SKU work on the owner's key, bounded per task, with no USDC purchase", async () => {
    env = createEnv();
    activateDefaults(env);
    const p = fakeProvider((_u, body) => openaiReply((body.max_tokens as number) === 2_000 ? "Analysis on your key." : "{\"plan\":true}"));
    const ai = new AiService(env.ledger, ProviderKeyVault.ephemeral(), p.fetchImpl);
    ai.set(env.ws.id, "owner", { provider: "openai", apiKey: KEY, model: "gpt-4.1-mini" });
    const agent = getAgent(env.ledger, env.agents.Prince.id)!;
    const taskId = runningTask(env, agent.id, "byok");

    const plan = await ai.plan(agent, { taskId, purpose: "plan", messages: [{ role: "user", content: "Plan it." }] });
    expect(plan.body).toMatchObject({ gateway: { outcome: { status: "succeeded", text: "{\"plan\":true}", mode: "byok" } } });
    expect(p.calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(p.calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);

    const run = await ai.run(agent, { taskId, sku: "analyze", input: { text: "Evidence.", question: "What matters?" } });
    expect(run).toMatchObject({ sku: "analyze", result: { text: "Analysis on your key." } });
    expect(Number(env.db.prepare("SELECT count(*) FROM purchase").pluck().get())).toBe(0);

    for (let i = 1; i < MAX_AI_CALLS_PER_TASK; i += 1) await ai.run(agent, { taskId, sku: "summarize", input: { text: "x" } });
    await expect(ai.run(agent, { taskId, sku: "summarize", input: { text: "x" } })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    await expect(ai.run(agent, { taskId, sku: "analyze", input: { wrong: 1 } })).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    // Model work stops with the agent, like purchases.
    const paused = runningTask(env, agent.id, "paused");
    env.db.prepare("UPDATE agent SET status = 'paused' WHERE id = ?").run(agent.id);
    await expect(ai.run({ ...agent, status: "paused" }, { taskId: paused, sku: "summarize", input: { text: "x" } })).rejects.toBeInstanceOf(ControlError);
  });

  it("speaks the Anthropic Messages API with the key in its own header", async () => {
    env = createEnv();
    activateDefaults(env);
    const p = fakeProvider(() => ({ model: "claude-sonnet-5-5", content: [{ type: "text", text: "Hello from Claude." }], usage: { input_tokens: 5, output_tokens: 4 } }));
    const ai = new AiService(env.ledger, ProviderKeyVault.ephemeral(), p.fetchImpl);
    ai.set(env.ws.id, "owner", { provider: "anthropic", apiKey: KEY, model: "claude-sonnet-5-5" });
    const taskId = runningTask(env, env.agents.Prince.id, "claude");
    const r = await ai.run(getAgent(env.ledger, env.agents.Prince.id)!, { taskId, sku: "summarize", input: { text: "Long text." } });
    expect(r).toMatchObject({ result: { text: "Hello from Claude." } });
    const call = p.calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.headers["x-api-key"]).toBe(KEY);
    expect(call.headers.authorization).toBeUndefined();
    expect(call.body).toMatchObject({ model: "claude-sonnet-5-5", messages: [{ role: "user" }] });
    expect(typeof call.body.system).toBe("string");
  });

  it("refuses unsafe base URLs and reports a rejected key as the owner's to fix", async () => {
    env = createEnv();
    activateDefaults(env);
    const reject = async () => new Response("{}", { status: 401 });
    const ai = new AiService(env.ledger, ProviderKeyVault.ephemeral(), reject);
    expect(() => ai.set(env.ws.id, "owner", { provider: "openai_compatible", apiKey: KEY, model: "m", baseUrl: "http://example.com/v1" })).toThrow(ControlError);
    expect(() => ai.set(env.ws.id, "owner", { provider: "openai_compatible", apiKey: KEY, model: "m", baseUrl: "https://u:p@example.com/v1" })).toThrow(ControlError);
    expect(ai.set(env.ws.id, "owner", { provider: "openai_compatible", apiKey: KEY, model: "llama3", baseUrl: "http://localhost:11434/v1" })).toMatchObject({ baseUrl: "http://localhost:11434/v1" });
    await expect(ai.test(env.ws.id)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    ai.clear(env.ws.id, "owner");
    expect(ai.configured(env.ws.id)).toBe(false);

    // With the real transport, a private-network provider is refused before any request is sent.
    const live = new AiService(env.ledger, ProviderKeyVault.ephemeral());
    live.set(env.ws.id, "owner", { provider: "openai_compatible", apiKey: KEY, model: "m", baseUrl: "https://10.0.0.5/v1" });
    await expect(live.test(env.ws.id)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});
