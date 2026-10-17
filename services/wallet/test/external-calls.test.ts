import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { advanceAuthority, getPurchaseRow, recordFundingFinalized } from "@veilo/control/src/ledger/purchases";
import type { FundingBinding, FundingResult } from "@veilo/contracts";
import { authorize, BINDING, createWorld, depositAndApprove, fundingInput, randomSignature, type TestWallet, type World } from "./harness";

let world: World;
let w: TestWallet;
beforeEach(async () => {
  world = await createWorld();
  w = world.open();
});
afterEach(() => world.cleanup());

const ledger = () => world.control.env.ledger;

// The harness SKU funds 100,000 base units: four calls of 25,000.
const EXTERNAL: FundingBinding = {
  ...BINDING,
  gatewayIdentity: "",
  external: { resourcePath: "/solana-mainnet", unitUsdc: "25000", maxCalls: 4 },
};

async function fundedBatch(key: string, binding: FundingBinding = EXTERNAL): Promise<string> {
  await depositAndApprove(world, w, 1_000_000n);
  const p = authorize(world, key);
  advanceAuthority(ledger(), p.id, "prepare_proof");
  expect((await w.funding.prepare({ ...fundingInput(world, p.id), binding })).status).toBe("prepared");
  advanceAuthority(ledger(), p.id, "release_proof");
  await w.funding.release(p.id, p.id);
  const fin = (await w.funding.status(p.id)) as Extract<FundingResult, { status: "finalized" }>;
  expect(fin.status).toBe("finalized");
  recordFundingFinalized(ledger(), p.id, {
    payout: fin.evidence.payout,
    tokenFees: fin.evidence.tokenFees,
    change: fin.evidence.change,
    changeCommitment: fin.evidence.changeCommitment,
    observedAtMs: fin.evidence.observedAtMs,
  });
  return p.id;
}

const call = (id: string, callIndex: number, binding: FundingBinding = EXTERNAL) => ({ purchaseId: id, fundingRef: id, callIndex, paymentRequired: {}, binding });

function land(messageHash: string) {
  world.chain.merchantTx.set(messageHash, { signature: randomSignature(), err: null, finalized: true });
}

describe("external x402 batch signing", () => {
  it("signs nothing until control authorizes the batch, then signs each index once", async () => {
    const id = await fundedBatch("x1");
    expect((await w.funding.signExternalCall(call(id, 0))).status).toBe("not_ready");
    expect(world.merchant.calls).toBe(0);
    advanceAuthority(ledger(), id, "sign_merchant");
    const a = await w.funding.signExternalCall(call(id, 0));
    const again = await w.funding.signExternalCall(call(id, 0));
    expect(a.status).toBe("signed");
    expect(again).toEqual(a);
    expect(world.merchant.calls).toBe(1);
  });

  it("refuses the next call while the previous one may still settle", async () => {
    const id = await fundedBatch("x2");
    advanceAuthority(ledger(), id, "sign_merchant");
    world.chain.validBlockhashes.add(world.merchant.blockhash);
    const first = await w.funding.signExternalCall(call(id, 0));
    expect((await w.funding.signExternalCall(call(id, 1))).status).toBe("not_ready");
    expect(await w.funding.externalCallOutcome(id, 0)).toEqual({ status: "signed" });
    if (first.status !== "signed") throw new Error("expected a signed call");
    land(first.messageHash);
    expect((await w.funding.externalCallOutcome(id, 0)).status).toBe("finalized");
    expect((await w.funding.signExternalCall(call(id, 1))).status).toBe("signed");
    expect(world.merchant.calls).toBe(2);
  });

  it("enforces order, the call limit and the funded payout", async () => {
    const id = await fundedBatch("x3");
    advanceAuthority(ledger(), id, "sign_merchant");
    expect((await w.funding.signExternalCall(call(id, 1))).status).toBe("recovery_required");
    for (let i = 0; i < 4; i += 1) {
      const s = await w.funding.signExternalCall(call(id, i));
      if (s.status !== "signed") throw new Error(`call ${i} not signed`);
      land(s.messageHash);
    }
    expect((await w.funding.signExternalCall(call(id, 4))).status).toBe("recovery_required");
    expect(world.merchant.calls).toBe(4);
    expect(await w.funding.merchantOutcome(id)).toBe("finalized");
  });

  it("refuses terms that do not divide the payout, a changed binding, or a non-batch binding", async () => {
    const odd: FundingBinding = { ...EXTERNAL, external: { resourcePath: "/solana-mainnet", unitUsdc: "30000", maxCalls: 4 } };
    const id = await fundedBatch("x4", odd);
    advanceAuthority(ledger(), id, "sign_merchant");
    expect((await w.funding.signExternalCall(call(id, 0, odd))).status).toBe("recovery_required");
    expect((await w.funding.signExternalCall(call(id, 0, { ...odd, payTo: "Other" }))).status).toBe("recovery_required");
    expect(world.merchant.calls).toBe(0);

    const plain = await fundedBatch("x5", BINDING);
    advanceAuthority(ledger(), plain, "sign_merchant");
    expect((await w.funding.signExternalCall(call(plain, 0, BINDING))).status).toBe("recovery_required");
    expect(world.merchant.calls).toBe(0);
  });

  it("never signs a single merchant payment from an external batch", async () => {
    const id = await fundedBatch("x6");
    advanceAuthority(ledger(), id, "sign_merchant");
    const r = await w.funding.signMerchant(id, { fundingRef: id, paymentRequired: {}, binding: EXTERNAL, exactAmountUsdc: 100_000n });
    expect(r.status).toBe("recovery_required");
    expect(world.merchant.calls).toBe(0);
  });

  it("holds recovery while a call may settle and allows it for the remainder afterwards", async () => {
    const id = await fundedBatch("x7");
    advanceAuthority(ledger(), id, "sign_merchant");
    world.chain.validBlockhashes.add(world.merchant.blockhash);
    const s = await w.funding.signExternalCall(call(id, 0));
    await expect(w.owner.prepareRecovery(id)).rejects.toMatchObject({ code: "SETTLEMENT_UNCERTAIN" });
    if (s.status !== "signed") throw new Error("expected a signed call");
    land(s.messageHash);
    expect(await w.funding.merchantOutcome(id)).toBe("finalized");
    expect(getPurchaseRow(ledger(), id).merchant_state).toBe("signed");
  });
});
