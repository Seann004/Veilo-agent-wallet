import { describe, expect, it } from "vitest";
import { parsedTokenTransfers } from "../src/chain";

describe("finalized transfer amounts", () => {
  it("reads exact token base units and ignores account creation rent and unrecognized instructions", () => {
    const ix = (program: string, type: string, info: unknown) => ({ program, parsed: { type, info } });
    expect(parsedTokenTransfers({ meta: { innerInstructions: [{ instructions: [
      ix("system", "createAccount", { lamports: 1488440 }),
      ix("spl-token", "transferChecked", { mint: "wsol", destination: "fresh-ata", tokenAmount: { amount: "726596" } }),
      ix("other-program", "transferChecked", { mint: "wsol", destination: "fresh-ata", tokenAmount: { amount: "999" } }),
      ix("spl-token", "transferChecked", { mint: "wsol", destination: "fresh-ata", tokenAmount: { amount: "invalid" } }),
    ] }] } })).toEqual([{ mint: "wsol", destination: "fresh-ata", amount: 726596n }]);
  });
  it("does not invent an output when metadata is absent", () => {
    expect(parsedTokenTransfers({ meta: null })).toEqual([]);
  });
});
