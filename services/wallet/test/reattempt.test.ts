import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { advanceAuthority, getPurchaseRow, recordFundingExpiredUnsettled } from "@veilo/control/src/ledger/purchases";
import { parseDecimal } from "@veilo/privacy-sdk";
import type { FundingInput } from "../src/funding";
import { authorize, createWorld, depositAndApprove, fundingInput, type TestWallet, type World } from "./harness";

let world: World;
let w: TestWallet;
beforeEach(async () => {
  world = await createWorld();
  w = world.open();
});
afterEach(() => world.cleanup());

const ledger = () => world.control.env.ledger;

async function released(key: string): Promise<string> {
  const p = authorize(world, key);
  advanceAuthority(ledger(), p.id, "prepare_proof");
  expect((await w.funding.prepare(fundingInput(world, p.id))).status).toBe("prepared");
  advanceAuthority(ledger(), p.id, "release_proof");
  await w.funding.release(p.id, p.id);
  return p.id;
}

/** A follow-up input for the same note under a new purchase reference (control untouched). */
const nextInput = (from: FundingInput): FundingInput => ({ ...from, purchaseId: randomUUID(), operationId: `${from.operationId}:attempt-2` });

describe("release whose relayer request was never recorded", () => {
  it("resends the identical material while the proof is within its slot bound", async () => {
    await depositAndApprove(world, w, 1_000_000n);
    world.relayer.mode = "error_unrecorded";
    const id = await released("unrec-1");
    expect((await w.funding.status(id)).status).toBe("uncertain");
    expect(world.relayer.withdrawals.size).toBe(0);
    world.relayer.mode = "land";
    expect((await w.funding.status(id)).status).toBe("submitted");
    expect((await w.funding.status(id)).status).toBe("finalized");
    // Every request carried the same withdrawal id, proof and intent: nothing was re-proved.
    const sent = new Set(world.relayer.received);
    expect(world.relayer.received.length).toBeGreaterThanOrEqual(2);
    expect(sent.size).toBe(1);
    expect(JSON.parse(world.relayer.received[0]!).withdrawalId).toBe(w.store.funding(id)!.relayer_withdrawal_id);
  });
});

describe("expired_unsettled, then a new attempt of the same logical operation", () => {
  it("after the bound passes with the nullifier unused, a new attempt gets a new proof and fresh wallet; the old proof is never resent", async () => {
    await depositAndApprove(world, w, 1_000_000n);
    world.relayer.mode = "error_unrecorded";
    const p1 = await released("exp-1");
    const before = { ...w.store.funding(p1)! };
    world.relayer.mode = "land";
    world.chain.slot = before.valid_until_slot + 1n;
    const sentBefore = world.relayer.received.length;
    expect((await w.funding.status(p1)).status).toBe("expired_unsettled");
    expect(world.relayer.received.length).toBe(sentBefore);
    const expiredRow = { ...w.store.funding(p1)! };
    recordFundingExpiredUnsettled(ledger(), p1);

    const p2 = authorize(world, "exp-2");
    advanceAuthority(ledger(), p2.id, "prepare_proof");
    const input = fundingInput(world, p2.id);
    expect(input.inputNote.commitment).toBe(w.store.note(before.input_note_id)!.commitment);
    const r = await w.funding.reattemptAfterExpiry(p1, input);
    expect(r.status).toBe("prepared");

    const f1 = w.store.funding(p1)!;
    const f2 = w.store.funding(p2.id)!;
    // The prior attempt is preserved: only its step moved to expired_unsettled.
    expect({ ...before, step: "expired_unsettled", updated_at_ms: expiredRow.updated_at_ms }).toEqual(expiredRow);
    // Same note and nullifier, but new proof material, bound, change secrets and fresh wallet.
    expect(f2.input_note_id).toBe(f1.input_note_id);
    expect(f2.nullifier_hash).toBe(f1.nullifier_hash);
    expect(f2.fresh_wallet).not.toBe(f1.fresh_wallet);
    expect(f2.change_note_id).not.toBe(f1.change_note_id);
    expect(f2.proof_json).not.toBe(f1.proof_json);
    expect(f2.valid_until_slot).toBeGreaterThan(f1.valid_until_slot);
    expect(w.store.events(p2.id).map((e) => e.kind)).toContain("funding.reattempt");

    advanceAuthority(ledger(), p2.id, "release_proof");
    await w.funding.release(p2.id, p2.id);
    expect((await w.funding.status(p2.id)).status).toBe("finalized");
    // The expired attempt stays terminal and is never resent.
    expect((await w.funding.release(p1, p1)).status).toBe("expired_unsettled");
    expect((await w.funding.status(p1)).status).toBe("expired_unsettled");
    expect(w.store.funding(p1)).toEqual(expiredRow);
    const spentRequests = world.relayer.received.map((x) => JSON.parse(x) as { withdrawalId: string; publicSignals: string[] });
    expect(spentRequests.filter((x) => x.withdrawalId === f1.relayer_withdrawal_id).length).toBe(sentBefore);
    expect(world.pool.spends).toHaveLength(1);
    expect(parseDecimal(world.pool.spends[0]!.nullifierHash).toString(16).padStart(64, "0")).toBe(f1.nullifier_hash);
  });

  it("refuses a new attempt while the prior one can still settle, and never double-spends the note", async () => {
    await depositAndApprove(world, w, 1_000_000n);
    world.relayer.mode = "hold";
    const p1 = await released("guard-1");
    const prior = w.store.funding(p1)!;
    const input = nextInput(fundingInput(world, p1));

    // Within the slot bound: not proven unsettled.
    const a = await w.funding.reattemptAfterExpiry(p1, input);
    expect(a.status).toBe("not_ready");
    expect(w.store.funding(input.purchaseId)).toBeUndefined();

    // The held withdrawal lands; past the bound the note is spent, so no new attempt is possible.
    const held = world.relayer.received.map((x) => JSON.parse(x) as Parameters<typeof world.relayer.land>[0])[0]!;
    await world.relayer.land(held, world.relayer.withdrawals.get(held.withdrawalId)!.signature!);
    world.chain.slot = prior.valid_until_slot + 1n;
    expect((await w.funding.status(p1)).status).toBe("finalized");
    const b = await w.funding.reattemptAfterExpiry(p1, input);
    expect(b.status).toBe("not_ready");
    expect(w.store.funding(input.purchaseId)).toBeUndefined();
    expect(world.pool.spends).toHaveLength(1);
  });

  it("refuses to reuse the prior purchase or operation reference, or a different input note", async () => {
    await depositAndApprove(world, w, 1_000_000n);
    world.relayer.mode = "error_unrecorded";
    const p1 = await released("refs-1");
    world.chain.slot = w.store.funding(p1)!.valid_until_slot + 1n;
    expect((await w.funding.status(p1)).status).toBe("expired_unsettled");
    const base = fundingInput(world, p1);
    expect((await w.funding.reattemptAfterExpiry(p1, base)).status).toBe("recovery_required");
    expect((await w.funding.reattemptAfterExpiry(p1, { ...base, purchaseId: randomUUID() })).status).toBe("recovery_required");
    const other = { ...nextInput(base), inputNote: { commitment: "00".repeat(32), value: base.inputNote.value } };
    expect((await w.funding.reattemptAfterExpiry(p1, other)).status).toBe("recovery_required");
    expect(getPurchaseRow(ledger(), p1).funding_state).not.toBe("finalized");
  });
});
