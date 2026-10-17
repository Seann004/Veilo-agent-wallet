import { describe, expect, it } from "vitest";
import { OpenRouterProvider } from "../src/provider/openrouter";
import { PINNED_MODELS } from "../src/provider/pinned-models";
import { ProviderError } from "../src/provider/types";

const REQUEST = { model: "deepseek/deepseek-v4-flash", messages: [{ role: "user" as const, content: "q" }], maxOutputTokens: 2000, jsonObject: false, maxPrice: { prompt: 0.091, completion: 0.182 } };

function capture(reply: unknown) {
  const bodies: Array<Record<string, unknown>> = [];
  const provider = new OpenRouterProvider("test-key", async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { provider, bodies };
}

const completion = (content: string | null, finish: string) => ({
  id: "gen-1",
  model: "deepseek/deepseek-v4-flash",
  choices: [{ message: { role: "assistant", content }, finish_reason: finish }],
  usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.00001 },
});

describe("OpenRouter reasoning control", () => {
  it("pins reasoning off for DeepSeek V4 Flash only", () => {
    expect(PINNED_MODELS["deepseek/deepseek-v4-flash"]!.reasoning).toBe("disabled");
    expect(PINNED_MODELS["mistralai/mistral-nemo"]!.reasoning).toBeUndefined();
  });

  it("sends reasoning.enabled=false only when asked", async () => {
    const a = capture(completion("answer", "stop"));
    expect((await a.provider.complete({ ...REQUEST, disableReasoning: true }, AbortSignal.timeout(1000))).text).toBe("answer");
    expect(a.bodies[0]!.reasoning).toEqual({ enabled: false });
    const b = capture(completion("answer", "stop"));
    await b.provider.complete(REQUEST, AbortSignal.timeout(1000));
    expect(b.bodies[0]).not.toHaveProperty("reasoning");
  });

  it("still refuses a reply whose output budget ended with no content", async () => {
    const c = capture(completion(null, "length"));
    const error = await c.provider.complete(REQUEST, AbortSignal.timeout(1000)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toBe("provider response carried no completion");
  });
});
