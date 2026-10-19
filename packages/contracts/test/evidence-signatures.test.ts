import { describe, expect, it } from "vitest";
import { evidenceSignatures } from "../../../scripts/evidence/signatures";

const signature = "2".repeat(88);
describe("submission receipt network labels", () => {
  it("does not turn a local integration signature into devnet evidence even with a devnet profile", () => {
    const [receipt] = evidenceSignatures({ profile: "devnet", signature }, "integration-2026-10-17.json");
    expect(receipt).toMatchObject({ network: "local-validator", explorer: null });
  });
  it("gives explicit local environment labels precedence over a devnet profile", () => {
    expect(evidenceSignatures({ profile: "devnet", environment: { chain: "solana-test-validator (not devnet)" }, signature }, "run.json")[0]).toMatchObject({ network: "local-validator", explorer: null });
  });
  it("gives the local-rehearsal profile precedence over contradictory network labels", () => {
    expect(evidenceSignatures({ profile: "local-rehearsal", network: "devnet", signature }, "state.json")[0]).toMatchObject({ network: "local-validator", explorer: null });
  });
  it("links explicitly identified devnet evidence and preserves its source", () => {
    expect(evidenceSignatures({ profile: "devnet", transaction: { signature } }, "m2-spend.json")[0]).toEqual({ signature, where: "m2-spend.json.transaction.signature", network: "devnet", explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet` });
  });
  it("leaves unlabeled signatures unknown instead of inferring devnet from a filename", () => {
    expect(evidenceSignatures({ signature }, "devnet-smoke.json")[0]).toMatchObject({ network: "unknown", explorer: null });
  });
});
