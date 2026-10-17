import { describe, expect, it } from "vitest";
import { argsTemplateProblem, connectorProposalSchema, mcpEndpointProblem, mcpManifestDigest, mcpToolDigest, renderArgs } from "../src/marketplace";

const tool = { name: "get_price", description: "Price for a coin id", inputSchema: { type: "object", properties: { ids: { type: "string" }, vs: { type: "string" } }, required: ["ids"] } };

describe("MCP tool pinning", () => {
  it("changes the digest when the name, description or input schema changes", () => {
    const d = mcpToolDigest(tool);
    expect(mcpToolDigest({ ...tool, description: "Price for a coin id." })).not.toBe(d);
    expect(mcpToolDigest({ ...tool, inputSchema: { ...tool.inputSchema, required: [] } })).not.toBe(d);
    expect(mcpToolDigest(structuredClone(tool))).toBe(d);
    expect(mcpManifestDigest([tool, { ...tool, name: "b" }])).toBe(mcpManifestDigest([{ ...tool, name: "b" }, tool]));
  });

  it("accepts only public https endpoints", () => {
    expect(mcpEndpointProblem("https://mcp.api.coingecko.com/mcp")).toBeNull();
    expect(mcpEndpointProblem("http://mcp.example.com/mcp")).toMatch(/https/);
    expect(mcpEndpointProblem("https://localhost/mcp")).toMatch(/public/);
    expect(mcpEndpointProblem("https://10.0.0.1/mcp")).toMatch(/public/);
    expect(mcpEndpointProblem("https://mcp.example.com/mcp?key=1")).toMatch(/query/);
    expect(connectorProposalSchema.safeParse({ id: "cg", title: "CoinGecko", endpoint: "https://mcp.api.coingecko.com/mcp", tools: [tool, tool] }).success).toBe(false);
  });

  it("places the step input only as a whole string value", () => {
    expect(argsTemplateProblem({ ids: "{{input}}", vs: "usd" }, tool.inputSchema)).toBeNull();
    expect(argsTemplateProblem({ vs: "usd" }, tool.inputSchema)).toMatch(/required/);
    expect(argsTemplateProblem({ ids: "{{input}}", extra: 1 }, tool.inputSchema)).toMatch(/not in the tool/);
    expect(argsTemplateProblem({ ids: "coin-{{input}}" }, tool.inputSchema)).toMatch(/exactly/);
    expect(argsTemplateProblem({ ids: "solana" }, tool.inputSchema)).toMatch(/once or more/);
    expect(renderArgs({ ids: "{{input}}", vs: "usd" }, '"},"x":"y')).toEqual({ ids: '"},"x":"y', vs: "usd" });
  });
});
