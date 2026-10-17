import { describe, expect, it } from "vitest";
import {
  canTransitionJob,
  computeQuoteDigest,
  quoteAmounts,
  quoteSchema,
  specialistJobInputSchema,
  verifyQuote,
  type QuoteFields,
} from "../src/marketplace";

const fields: QuoteFields = {
  id: "8d4f3a8e-2b61-4c4a-9a51-0d3c1f7e6a01",
  operationId: "op_hire_1",
  buyerWorkspaceId: "1b0c6a3e-5a7d-4e7f-8f61-2c3d4e5f6a7b",
  jobId: "2c1d7b4f-6b8e-4f80-9a72-3d4e5f6a7b8c",
  listingVersionId: "3d2e8c5a-7c9f-4a91-8b83-4e5f6a7b8c9d",
  runtimeVersion: "managed:research-summary:v1",
  inputDigest: "a".repeat(64),
  network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  decimals: 6,
  recipient: "49TED53TmAC4EsScoN3zn6iTHZXAcz6J5w9trmnyAVWX",
  recipientAta: "9YVRYnbzEojUGCNVuW1eGjjzPywAYYWRV92omacRjMuC",
  sellerOrigin: "http://127.0.0.1:4106",
  sellerIdentity: "veilo-seller-host-devnet",
  baseUnits: "250000",
  feeBps: 0,
  feeUnits: "0",
  totalUnits: "250000",
  maxNetworkFeeLamports: "10000000",
  termsVersion: "2026-10-17",
  expiresAt: "2026-10-17T05:00:00.000Z",
};

describe("marketplace quote", () => {
  it("binds every field into the digest", () => {
    const quote = quoteSchema.parse({ ...fields, quoteDigest: computeQuoteDigest(fields) });
    expect(verifyQuote(quote)).toBeNull();
    for (const [key, value] of [
      ["recipient", "8djHL1qrsvv6mJJVbfw6i8A1nqeGDw4SQor7YW8tKtcD"],
      ["totalUnits", "250001"],
      ["mint", "So11111111111111111111111111111111111111112"],
      ["jobId", "4e3f9d6b-8da0-4ba2-9c94-5f6a7b8c9d0e"],
    ] as const) {
      expect(verifyQuote({ ...quote, [key]: value })).toBe("quote digest does not match its fields");
    }
  });

  it("refuses a nonzero fee and inconsistent totals", () => {
    expect(() => quoteAmounts(1_000n, 100)).toThrow();
    expect(quoteAmounts(1_000n)).toEqual({ base: 1_000n, fee: 0n, total: 1_000n });
    const bad = { ...fields, totalUnits: "250001" };
    expect(verifyQuote({ ...bad, quoteDigest: computeQuoteDigest(bad) })).toBe("quote fee arithmetic is inconsistent");
    const feeQuote = { ...fields, feeBps: 100 };
    expect(verifyQuote({ ...feeQuote, quoteDigest: computeQuoteDigest(feeQuote) })).toMatch(/fee basis points/);
  });

  it("rejects malformed amounts", () => {
    expect(() => computeQuoteDigest({ ...fields, baseUnits: "01" })).toThrow();
    expect(() => computeQuoteDigest({ ...fields, baseUnits: "-1" })).toThrow();
    expect(() => computeQuoteDigest({ ...fields, baseUnits: "1.5" })).toThrow();
  });
});

describe("job state machine", () => {
  it("never queues work straight from creation or approval", () => {
    expect(canTransitionJob("created", "queued")).toBe(false);
    expect(canTransitionJob("awaiting_approval", "queued")).toBe(false);
    expect(canTransitionJob("awaiting_payment", "queued")).toBe(true);
    expect(canTransitionJob("succeeded", "running")).toBe(false);
  });
});

describe("specialist job input", () => {
  it("is strict", () => {
    const ok = { jobId: fields.jobId, listingVersionId: fields.listingVersionId, quoteDigest: "b".repeat(64), brief: "Summarize devnet x402 adoption" };
    expect(specialistJobInputSchema.parse(ok)).toEqual(ok);
    expect(specialistJobInputSchema.safeParse({ ...ok, recipient: "x" }).success).toBe(false);
  });
});

describe("remote seller origin", () => {
  it("accepts only bare public https origins", async () => {
    const { remoteOriginProblem } = await import("../src/marketplace");
    expect(remoteOriginProblem("https://seller.example.com")).toBeNull();
    for (const bad of [
      "http://seller.example.com",
      "https://user:pw@seller.example.com",
      "https://seller.example.com/path",
      "https://seller.example.com?x=1",
      "https://localhost",
      "https://127.0.0.1",
      "https://169.254.169.254",
      "https://[::1]",
      "https://metadata.google.internal",
      "https://intranet",
    ]) {
      expect(remoteOriginProblem(bad), bad).not.toBeNull();
    }
  });
});

describe("payer binding message", () => {
  it("is domain separated and binds operation, quote and payer", async () => {
    const { payerBindingMessage } = await import("../src/marketplace");
    expect(payerBindingMessage("op_1", "a".repeat(64), "49TED53TmAC4EsScoN3zn6iTHZXAcz6J5w9trmnyAVWX")).toBe(
      `veilo:payer-binding:v1\nop_1\n${"a".repeat(64)}\n49TED53TmAC4EsScoN3zn6iTHZXAcz6J5w9trmnyAVWX`,
    );
  });
});
