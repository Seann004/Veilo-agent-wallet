import { describe, expect, it } from "vitest";
import { SUPPORTED_X402_NETWORK } from "../src/index";

describe("x402-client", () => {
  it("targets Solana devnet only", () => {
    expect(SUPPORTED_X402_NETWORK).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
  });
});
