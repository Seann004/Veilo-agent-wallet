// FIXTURE upstream: a loopback OpenRouter-compatible mock (chat/completions, models, key) for
// integration tests and local rehearsals. Its output is deterministic, labeled fixture text and
// never counts as real inference. Behaviors let tests script provider timeouts, definite
// rejections (exhausted account) and price changes.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type MockBehavior = "ok" | "timeout" | "exhausted" | "server_error";

export const MOCK_PRICING = { prompt: "0.000000029", completion: "0.00000003" };
export const MOCK_PRICE_INCREASED = { prompt: "0.000001", completion: "0.000002" };

export interface MockProvider {
  url: string;
  behavior: MockBehavior;
  pricing: { prompt: string; completion: string };
  calls: Array<{ system: string; user: string; model: string }>;
  close(): Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

function reply(system: string, user: string): string {
  if (system.includes("Return only a JSON object")) {
    const channels = /Channels: (.*)/.exec(user)?.[1]?.split(", ") ?? ["LinkedIn", "Newsletter", "Instagram"];
    return JSON.stringify({
      drafts: channels.slice(0, 3).map((channel, i) => ({ channel, title: `FIXTURE draft ${i + 1} for ${channel}`, body: `FIXTURE body (mock provider, not real inference) for ${channel}.` })),
      calendar: [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, channel: channels[(day - 1) % 3], draftIndex: day <= 3 ? day - 1 : null, action: day <= 3 ? "post draft" : "engage and review" })),
    });
  }
  if (system.includes('"dataset"')) return JSON.stringify({ dataset: "research-expanded", rationale: "FIXTURE plan: the expanded dataset covers more sources within budget." });
  if (system.includes('"gaps"')) return JSON.stringify({ gaps: ["FIXTURE open question: long-term outcomes are not measured in the purchased records."] });
  if (system.startsWith("Condense")) return "- FIXTURE condensed point from the approved brief [1]\n- FIXTURE second point [2]";
  return "FIXTURE analysis (mock provider, not real inference): the purchased records describe community repair outcomes [1] and volunteer growth [2].";
}

export async function startMockProvider(port: number): Promise<MockProvider> {
  const m: MockProvider = { url: "", behavior: "ok", pricing: { ...MOCK_PRICING }, calls: [], close: async () => undefined };
  const server: Server = createServer((req, res) => {
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    void (async () => {
      if (req.method === "GET" && req.url === "/models") return json(200, { data: [{ id: "mistralai/mistral-nemo", pricing: m.pricing }] });
      if (req.method === "GET" && req.url === "/key") return json(200, { data: { limit: null, limit_remaining: null, label: "local mock" } });
      if (req.method !== "POST" || req.url !== "/chat/completions") return json(404, { error: { message: "not found" } });
      const body = await readJson(req);
      const messages = (body.messages as Array<{ role: string; content: string }>) ?? [];
      const system = messages.find((x) => x.role === "system")?.content ?? "";
      const user = messages.filter((x) => x.role === "user").map((x) => x.content).join("\n");
      m.calls.push({ system: system.slice(0, 200), user: user.slice(0, 200), model: String(body.model) });
      if (m.behavior === "timeout") return; // never answers; the gateway's single attempt times out
      if (m.behavior === "exhausted") return json(402, { error: { code: 402, message: "Insufficient credits (mock)" } });
      if (m.behavior === "server_error") return json(502, { error: { message: "upstream error (mock)" } });
      const text = reply(system, user);
      json(200, {
        id: `gen-mock-${m.calls.length}`,
        model: body.model,
        choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: Math.ceil((system.length + user.length) / 4), completion_tokens: Math.ceil(text.length / 4), cost: 0.000002 },
      });
    })();
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  m.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  m.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return m;
}
