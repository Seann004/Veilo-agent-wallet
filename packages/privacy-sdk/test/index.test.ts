import { describe, expect, it } from "vitest";
import { PROOF_SYSTEM } from "../src/index";

describe("privacy-sdk", () => {
  it("declares BN254 Groth16", () => {
    expect(PROOF_SYSTEM).toEqual({ curve: "bn254", protocol: "groth16" });
  });
});
