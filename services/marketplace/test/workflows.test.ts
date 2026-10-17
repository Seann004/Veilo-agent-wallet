import { describe, expect, it } from "vitest";
import { callTemplateProblem } from "../src/workflows";

const io = { inputs: [{ name: "mint", kind: "text" as const, required: true, maxChars: 64 }], output: { kind: "json" as const } };
const rpc = (method: string, params: unknown[]) => ({ method: "POST", path: "/solana-mainnet", body: { jsonrpc: "2.0", id: 1, method, params } });
const tool = (callTemplate: Array<{ method: string; path: string; body?: unknown }>, over: Record<string, unknown> = {}) => ({
  resourcePath: "/solana-mainnet",
  callsPerStep: callTemplate.length,
  rpcMethods: ["getTokenSupply", "getTokenLargestAccounts"],
  io,
  callTemplate,
  ...over,
});

describe("external tool call templates", () => {
  it("accepts calls on the approved path with allowed methods and whole-input placeholders", () => {
    expect(callTemplateProblem(tool([rpc("getTokenSupply", ["{{mint}}"]), rpc("getTokenLargestAccounts", ["{{mint}}"])]))).toBeNull();
  });

  it("refuses a call count that differs from the paid calls", () => {
    expect(callTemplateProblem(tool([rpc("getTokenSupply", ["{{mint}}"])], { callsPerStep: 2 }))).toMatch(/exactly one call/);
  });

  it("refuses other paths, disallowed methods, GET bodies and dot segments", () => {
    expect(callTemplateProblem(tool([{ ...rpc("getTokenSupply", []), path: "/base-mainnet" }]))).toMatch(/leaves the approved/);
    expect(callTemplateProblem(tool([rpc("sendTransaction", ["x"])]))).toMatch(/not allowed/);
    expect(callTemplateProblem(tool([{ method: "GET", path: "/solana-mainnet", body: {} }], { rpcMethods: undefined }))).toMatch(/GET/);
    expect(callTemplateProblem(tool([{ method: "POST", path: "/v1/../admin" }], { resourcePath: "/v1/*", rpcMethods: undefined }))).toMatch(/leaves the approved/);
  });

  it("refuses placeholders that are partial, unknown or embedded in other text", () => {
    expect(callTemplateProblem(tool([rpc("getTokenSupply", ["{{wallet}}"])]))).toMatch(/placeholder/);
    expect(callTemplateProblem(tool([rpc("getTokenSupply", ["prefix-{{mint}}"])]))).toMatch(/placeholder/);
  });
});
