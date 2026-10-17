import { SOLANA_ERROR__JSON_RPC__INVALID_PARAMS, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { describeError, isTransientRpcError } from "../src/diagnostics";

describe("wallet error diagnostics (T12)", () => {
  it("logs a Solana RPC error's code and status without headers or URL paths", () => {
    const e = new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
      headers: new Headers({ authorization: "Bearer hidden" }),
      message: "Too Many Requests from https://rpc.example/v1/sk-abc123?api-key=k",
      statusCode: 429,
    });
    const line = describeError(e);
    expect(line).toBe('SolanaError __code=8100002 statusCode=429 message="Too Many Requests from https://rpc.example/…"');
    expect(line).not.toMatch(/hidden|sk-abc123|api-key/);
    expect(isTransientRpcError(e)).toBe(true);
  });

  it("treats network and timeout failures as transient, but not invalid requests or policy errors", () => {
    expect(isTransientRpcError(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) }))).toBe(true);
    expect(isTransientRpcError(new DOMException("timed out", "TimeoutError"))).toBe(true);
    expect(describeError(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) }))).toBe('TypeError code=ECONNRESET "fetch failed"');
    expect(isTransientRpcError(new SolanaError(SOLANA_ERROR__JSON_RPC__INVALID_PARAMS, { __serverMessage: "bad" }))).toBe(false);
    const policy = new Error("challenge payTo 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU does not match");
    expect(isTransientRpcError(policy)).toBe(false);
    // Messages of non-network errors are not repeated: they can quote request data.
    expect(describeError(policy)).toBe("Error");
  });
});
