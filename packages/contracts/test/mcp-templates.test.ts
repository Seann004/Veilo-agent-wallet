import { describe, expect, it } from "vitest";
import {
  codeExecutionToolProblem,
  connectorProposalSchema,
  MCP_TEMPLATES,
  mcpTemplateCodeDigest,
  mcpToolDigest,
  renderTemplatedCall,
  templatedToolPin,
  templatedToolProblem,
} from "../src/marketplace";

const ENDPOINT = "https://mcp.api.coingecko.com/mcp";
const UPSTREAM = "a".repeat(64);
const EXECUTE = {
  name: "execute",
  description: "Run code against the CoinGecko SDK",
  inputSchema: { type: "object", properties: { code: { type: "string" }, intent: { type: "string" } }, required: ["code"] },
};

describe("templated MCP tools", () => {
  it("renders the exact fixed code with the validated values as JSON literals", () => {
    expect(renderTemplatedCall("coingecko_simple_price", { ids: ["bitcoin", "ethereum"], vs_currencies: ["usd", "sgd"] })).toEqual({
      ok: true,
      upstream: "execute",
      args: { code: 'async function run(client) { return await client.simple.price.get({"ids":"bitcoin,ethereum","vs_currencies":"usd,sgd","include_24hr_change":true}); }' },
    });
    expect(renderTemplatedCall("coingecko_simple_price", { ids: ["solana"] })).toMatchObject({ args: { code: expect.stringContaining('{"ids":"solana","vs_currencies":"usd","include_24hr_change":true}') } });
    expect(renderTemplatedCall("coingecko_search", { query: "Bitcoin Cash" })).toEqual({
      ok: true,
      upstream: "execute",
      args: {
        code: 'async function run(client) { const r = await client.search.get({"query":"Bitcoin Cash"}); return (r.coins ?? []).slice(0, 5).map((c) => ({ id: c.id, name: c.name, symbol: c.symbol })); }',
      },
    });
    expect(renderTemplatedCall("coingecko_trending", {})).toEqual({
      ok: true,
      upstream: "execute",
      args: {
        code: "async function run(client) { const r = await client.search.trending.get(); return (r.coins ?? []).slice(0, 15).map((c) => ({ name: c.item.name, symbol: c.item.symbol, rank: c.item.market_cap_rank })); }",
      },
    });
  });

  it("refuses quotes, backticks, template interpolation, newlines and anything outside the schema", () => {
    const hostile = ['bitcoin"', "bit`coin", "${process.env}", "bitcoin\nreturn 1", "bitcoin'", "BITCOIN", "bit coin", "a".repeat(65), "", "bitcoin});fetch(1"];
    for (const id of hostile) expect(renderTemplatedCall("coingecko_simple_price", { ids: [id] }).ok, JSON.stringify(id)).toBe(false);
    for (const query of ['btc"', "btc`", "${x}", "btc\n", "btc;", "a".repeat(41), "", "btc)"]) expect(renderTemplatedCall("coingecko_search", { query }).ok, JSON.stringify(query)).toBe(false);
    expect(renderTemplatedCall("coingecko_simple_price", { ids: ["bitcoin"], vs_currencies: ["usd", "doge"] }).ok).toBe(false);
    expect(renderTemplatedCall("coingecko_simple_price", { ids: Array.from({ length: 11 }, (_, i) => `c${i}`) }).ok).toBe(false);
    expect(renderTemplatedCall("coingecko_simple_price", { ids: ["bitcoin"], code: "x" }).ok).toBe(false);
    expect(renderTemplatedCall("coingecko_simple_price", { ids: "bitcoin" }).ok).toBe(false);
    expect(renderTemplatedCall("coingecko_trending", { limit: 5 }).ok).toBe(false);
    expect(renderTemplatedCall("execute", { code: "async function run() {}" })).toEqual({ ok: false, problem: "tool execute is not a known Veilo template" });
  });

  it("treats code-execution tools as never directly callable", () => {
    expect(codeExecutionToolProblem(EXECUTE)).toMatch(/caller-supplied code/);
    expect(codeExecutionToolProblem({ name: "run_snippet", inputSchema: { properties: { code: { type: "string" } } } })).toMatch(/caller-supplied code/);
    expect(codeExecutionToolProblem({ name: "search_docs", inputSchema: { properties: { query: { type: "string" } } } })).toBeNull();
    expect(connectorProposalSchema.safeParse({ id: "coingecko-raw", title: "CoinGecko raw", endpoint: ENDPOINT, tools: [EXECUTE] }).success).toBe(false);
  });

  it("approves a templated pin only for its host, schema and exact code, and pins the upstream digest", () => {
    const pins = MCP_TEMPLATES.map((t) => templatedToolPin(t.name, UPSTREAM));
    expect(connectorProposalSchema.safeParse({ id: "coingecko-market", title: "CoinGecko market data", endpoint: ENDPOINT, tools: pins }).success).toBe(true);
    expect(connectorProposalSchema.safeParse({ id: "elsewhere", title: "Elsewhere", endpoint: "https://mcp.example.com/mcp", tools: pins }).success).toBe(false);
    const pin = pins[0]!;
    expect(templatedToolProblem(pin, ENDPOINT)).toBeNull();
    expect(templatedToolProblem({ ...pin, template: { ...pin.template, codeSha256: "0".repeat(64) } }, ENDPOINT)).toMatch(/code changed/);
    expect(templatedToolProblem({ ...pin, inputSchema: { type: "object", properties: {} } }, ENDPOINT)).toMatch(/input schema/);
    expect(templatedToolProblem({ ...pin, template: { ...pin.template, upstream: "search_docs" } }, ENDPOINT)).toMatch(/only through execute/);
    expect(templatedToolProblem({ ...pin, name: "coingecko_everything" }, ENDPOINT)).toMatch(/not a known/);
    expect(pin.template.codeSha256).toBe(mcpTemplateCodeDigest(MCP_TEMPLATES[0]!));
    // The tool digest covers the upstream digest, so approval records it.
    expect(mcpToolDigest(templatedToolPin(pin.name, "b".repeat(64)))).not.toBe(mcpToolDigest(pin));
    expect(mcpToolDigest({ ...pin, template: undefined })).not.toBe(mcpToolDigest(pin));
  });
});
