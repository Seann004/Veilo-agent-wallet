// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiProviderSettings } from "../components/AiProviderSettings";
import { withRole } from "./access-fixtures";

interface Call {
  url: string;
  method: string;
  body: unknown;
}
let calls: Call[];
let saved: Record<string, unknown> | null;
const KEY = "sk-ant-api03-very-secret-key-9f2c";

beforeEach(() => {
  document.cookie = "veilo_csrf=csrf-ai";
  calls = [];
  saved = null;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const c = { url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(c);
    if (c.method === "PUT") {
      const b = c.body as { provider: string; model: string; apiKey: string };
      saved = { provider: b.provider, baseUrl: "https://api.anthropic.com/v1", model: b.model, keyHint: `…${b.apiKey.slice(-4)}`, updatedAt: "2026-10-18T00:00:00.000Z" };
      return new Response(JSON.stringify({ provider: saved }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ provider: saved }), { status: 200, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AI model settings", () => {
  it("sends the key once, clears the field and shows only its last four characters", async () => {
    const user = userEvent.setup();
    render(withRole(<AiProviderSettings />, "owner"));
    expect(await screen.findByText(/No AI key yet/)).toBeTruthy();
    await user.click(screen.getByLabelText("Provider"));
    await user.click(await screen.findByRole("option", { name: /Anthropic \(Claude\)/ }));
    await user.type(screen.getByLabelText("API key"), KEY);
    await user.click(screen.getByLabelText("Model"));
    await user.click(await screen.findByRole("option", { name: "claude-sonnet-5-5" }));
    await user.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() => expect(screen.getByText("…9f2c")).toBeTruthy());
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toContain("/api/control/ai-provider");
    expect(put.body).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5", apiKey: KEY });
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain(KEY);
  });

  it("sets up a Z.ai GLM coding-plan key with a model loaded from the provider", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const c = { url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
      calls.push(c);
      if (c.url.endsWith("/ai-provider/models")) return new Response(JSON.stringify({ models: ["glm-5.3", "glm-5.3-flash", "glm-5.3-air"] }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ provider: null }), { status: 200, headers: { "content-type": "application/json" } });
    });
    render(withRole(<AiProviderSettings />, "owner"));
    await screen.findByText(/No AI key yet/);
    await user.click(screen.getByLabelText("Provider"));
    await user.click(await screen.findByRole("option", { name: /Z\.ai \(GLM\)/ }));
    await user.click(screen.getByLabelText("This is a GLM Coding Plan key"));
    await user.type(screen.getByLabelText("API key"), "zai-key-123456789");
    await user.click(screen.getByRole("button", { name: "Load models" }));
    await screen.findByText("3 models from your provider.");
    const list = calls.find((c) => c.url.endsWith("/ai-provider/models"))!;
    expect(list.body).toEqual({ provider: "openai_compatible", apiKey: "zai-key-123456789", baseUrl: "https://api.z.ai/api/coding/paas/v4" });
    await user.click(screen.getByLabelText("Model"));
    await user.click(await screen.findByRole("option", { name: "glm-5.3-flash" }));
    await user.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ provider: "openai_compatible", model: "glm-5.3-flash", apiKey: "zai-key-123456789", baseUrl: "https://api.z.ai/api/coding/paas/v4" });
  });

  it("switches the saved Z.ai model without asking for the key again", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const c = { url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
      calls.push(c);
      const saved = { provider: "openai_compatible", baseUrl: "https://api.z.ai/api/paas/v4", model: "glm-5.3-flash", keyHint: "…7890", updatedAt: "2026-10-18T00:00:00Z" };
      return new Response(JSON.stringify({ provider: c.method === "PUT" ? { ...saved, model: c.body.model } : saved }), { status: 200, headers: { "content-type": "application/json" } });
    });
    render(withRole(<AiProviderSettings />, "owner"));
    await screen.findByText(/Leave blank to keep your saved key \(…7890\)/);
    expect(screen.getByLabelText("Provider").textContent).toContain("Z.ai (GLM)");
    await user.click(screen.getByLabelText("Model"));
    await user.click(await screen.findByRole("option", { name: "glm-5.3" }));
    await user.click(screen.getByRole("button", { name: "Save model" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ provider: "openai_compatible", model: "glm-5.3", baseUrl: "https://api.z.ai/api/paas/v4" });
  });
});
