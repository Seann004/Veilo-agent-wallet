import { describe, expect, it } from "vitest";
import { evaluateDemoAcceptance, tokenCreditTo, type AcceptanceInput, type AcceptancePurchase } from "../../../scripts/demo/acceptance";

const agents = { shawn: "agt_shawn", prince: "agt_prince", mira: "agt_mira" };

function purchase(id: string, agentId: string, sku: string, price: string, merchantSig: string | null, extra: Partial<AcceptancePurchase> = {}): AcceptancePurchase {
  return {
    id,
    agentId,
    sku,
    paymentPath: "private_x402",
    price: { amount: price },
    states: { fulfilment: "delivered" },
    chainAttempts: [
      { leg: "funding", signature: `fund-${id}` },
      { leg: "merchant", signature: merchantSig },
    ],
    ...extra,
  };
}

function passing(): AcceptanceInput {
  return {
    providerMode: "live",
    agents,
    tasks: { prince: { state: "completed" }, mira: { state: "completed" } },
    purchases: [
      purchase("p1", agents.shawn, "inference-credit-pack", "1000000", "m1"),
      purchase("p2", agents.prince, "research-expanded", "200000", "m2"),
      { id: "p3", agentId: agents.prince, sku: "analyze", paymentPath: "prepaid_credits", price: { amount: "0" }, states: { fulfilment: "delivered" } },
      purchase("p4", agents.mira, "content-package", "300000", "m4"),
    ],
    receipts: [
      { sourceKind: "planning", sku: null, mode: "live", state: "succeeded" },
      { sourceKind: "usage", sku: "analyze", mode: "live", state: "succeeded" },
      { sourceKind: "purchase", sku: "content-package", mode: "live", state: "succeeded" },
    ],
    merchantCredits: { m1: 1_000_000n, m2: 200_000n, m4: 300_000n },
  };
}

const failed = (i: AcceptanceInput) => evaluateDemoAcceptance(i).checks.filter((c) => !c.ok).map((c) => c.name);

describe("demo:run acceptance", () => {
  it("passes a complete live run", () => {
    const r = evaluateDemoAcceptance(passing());
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it("fails when a task ended failed or incomplete", () => {
    const i = passing();
    i.tasks.prince = { state: "failed" };
    i.tasks.mira = { state: "incomplete" };
    expect(failed(i)).toEqual(["Prince research task completed", "Mira content task completed"]);
  });

  it("fails when a merchant leg did not credit the gateway merchant ATA with the price", () => {
    const i = passing();
    i.merchantCredits.m4 = null;
    i.merchantCredits.m2 = 100_000n;
    expect(failed(i)).toEqual(["Prince research dataset merchant leg paid the gateway merchant", "Mira content package merchant leg paid the gateway merchant"]);
  });

  it("fails when a purchase was not delivered, has no merchant signature or was bought twice", () => {
    const i = passing();
    i.purchases[0]!.states = { fulfilment: "failed" };
    i.purchases.push(purchase("p5", agents.prince, "research-basic", "100000", "m5"));
    i.merchantCredits.m5 = 100_000n;
    i.purchases[3]!.chainAttempts = [{ leg: "funding", signature: "f" }];
    expect(failed(i)).toEqual(["Shawn credit pack delivered once via private x402", "Prince research dataset delivered once via private x402", "Mira content package merchant leg paid the gateway merchant"]);
  });

  it("fails a live run that used the fixture provider or lacks real inference", () => {
    const i = passing();
    i.receipts = [
      { sourceKind: "usage", sku: "analyze", mode: "fixture", state: "succeeded" },
      { sourceKind: "purchase", sku: "content-package", mode: "live", state: "failed" },
    ];
    expect(failed(i)).toEqual(["analyze inference succeeded (live)", "content-package inference succeeded (live)", "no fixture provider call in a live run"]);
  });

  it("accepts fixture receipts only in fixture mode", () => {
    const i = passing();
    i.providerMode = "fixture";
    i.receipts = i.receipts.map((r) => ({ ...r, mode: "fixture" }));
    expect(evaluateDemoAcceptance(i).passed).toBe(true);
  });
});

describe("tokenCreditTo", () => {
  const tx = (err: unknown, pre: string, post: string) => ({
    transaction: { message: { accountKeys: [{ pubkey: "payer" }, { pubkey: "payerAta" }, { pubkey: "merchantAta" }] } },
    meta: {
      err,
      preTokenBalances: [
        { accountIndex: 1, uiTokenAmount: { amount: "500000" } },
        { accountIndex: 2, uiTokenAmount: { amount: pre } },
      ],
      postTokenBalances: [
        { accountIndex: 1, uiTokenAmount: { amount: "200000" } },
        { accountIndex: 2, uiTokenAmount: { amount: post } },
      ],
    },
  });

  it("returns the amount credited to the ATA", () => {
    expect(tokenCreditTo(tx(null, "1500000", "1800000"), "merchantAta")).toBe(300_000n);
  });

  it("returns null for a failed transaction, a missing transaction, another ATA or a debit", () => {
    expect(tokenCreditTo(tx({ InstructionError: [0, "x"] }, "0", "300000"), "merchantAta")).toBeNull();
    expect(tokenCreditTo(null, "merchantAta")).toBeNull();
    expect(tokenCreditTo(tx(null, "0", "300000"), "otherAta")).toBeNull();
    expect(tokenCreditTo(tx(null, "300000", "0"), "merchantAta")).toBeNull();
  });
});
