import { readFileSync } from "node:fs";
import { join } from "node:path";
import { address, getCompiledTransactionMessageDecoder } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pauseAgent } from "@veilo/control/src/ledger/authority";
import { reserveNote } from "@veilo/control/src/ledger/notes";
import { advanceAuthority, getPurchaseRow, recordFundingFinalized } from "@veilo/control/src/ledger/purchases";
import { tokenBuckets } from "@veilo/control/src/ledger/notes";
import { immediate } from "@veilo/db";
import { instructionDiscriminator } from "@veilo/privacy-sdk";
import { decodeWireTransaction } from "@veilo/x402-client";
import { authorize, BINDING, createWorld, depositAndApprove, freshAta, fundingInput, randomSignature, type TestWallet, type World } from "./harness";
import type { FundingResult } from "@veilo/contracts";

let world: World;
let w: TestWallet;
beforeEach(async () => {
  world = await createWorld();
  w = world.open();
});
afterEach(() => world.cleanup());

const ledger = () => world.control.env.ledger;
const control = (id: string) => getPurchaseRow(ledger(), id);

async function prepared(key: string) {
  const p = authorize(world, key);
  advanceAuthority(ledger(), p.id, "prepare_proof");
  const r = await w.funding.prepare(fundingInput(world, p.id));
  expect(r.status).toBe("prepared");
  return p.id;
}

async function releasedAndFinal(id: string): Promise<Extract<FundingResult, { status: "finalized" }>> {
  advanceAuthority(ledger(), id, "release_proof");
  const rel = await w.funding.release(id, id);
  expect(["submitted", "uncertain"]).toContain(rel.status);
  const st = await w.funding.status(id);
  expect(st.status).toBe("finalized");
  return st as Extract<FundingResult, { status: "finalized" }>;
}

function recordInControl(id: string, r: Extract<FundingResult, { status: "finalized" }>) {
  recordFundingFinalized(ledger(), id, {
    payout: r.evidence.payout,
    tokenFees: r.evidence.tokenFees,
    change: r.evidence.change,
    changeCommitment: r.evidence.changeCommitment,
    observedAtMs: r.evidence.observedAtMs,
  });
}

describe("private funding: original note, then its change note (PRIV-01 flow, LED-01)", () => {
  it("funds a fresh wallet, keeps change unavailable until inserted, then spends the change", async () => {
    await depositAndApprove(world, w, 1_000_000n);
    const status = w.notes.status() as { notes: Array<{ state: string; available: boolean; depositStages: Record<string, boolean> }> };
    expect(status.notes[0]!.state).toBe("spendable");
    expect(status.notes[0]!.depositStages).toEqual({ submitted: true, finalized: true, indexed: true, approved: true, spendable: true });

    const id1 = await prepared("p1");
    const f1 = w.store.funding(id1)!;
    const intent = JSON.parse(f1.intent_json) as { validUntilSlot: string; destinationOwner: string; destinationTokenAccount: string; relayer: string };
    // valid_until_slot <= finalized slot + 750, the destination is the fresh wallet's ATA and the relayer is bound.
    expect(BigInt(intent.validUntilSlot)).toBe(world.chain.slot + 750n);
    expect(intent.destinationOwner).toBe(f1.fresh_wallet);
    expect(intent.destinationTokenAccount).toBe(await freshAta(world, f1.fresh_wallet));
    expect(intent.relayer).toBe(world.ctx.relayer);

    const fin = await releasedAndFinal(id1);
    expect(fin.evidence.payout).toBe(100_000n);
    expect(fin.evidence.change).toBe(900_000n);
    recordInControl(id1, fin);

    // LED-01: the pending change cannot be reserved before its insertion is finalized.
    expect(() => immediate(ledger().db, () => reserveNote(ledger(), world.control.env.ws.id, "00000000-0000-0000-0000-000000000000", 1n))).toThrow(/NOTE_PENDING|pending/i);
    expect(tokenBuckets(ledger(), world.control.env.ws.id).pending_change).toBe(900_000n);
    await w.notes.sync();
    expect(w.store.note(f1.change_note_id)!.state).toBe("pending_change");

    world.pool.insertAll();
    await w.notes.sync();
    expect(w.store.note(f1.change_note_id)!.state).toBe("spendable");
    expect(tokenBuckets(ledger(), world.control.env.ws.id).confirmed_change).toBe(900_000n);

    // Spend the change note: control reserves it, the wallet proves membership of the change leaf.
    const id2 = await prepared("p2");
    expect(w.store.funding(id2)!.input_note_id).toBe(f1.change_note_id);
    const fin2 = await releasedAndFinal(id2);
    expect(fin2.evidence.change).toBe(800_000n);
    expect(w.store.funding(id2)!.fresh_wallet).not.toBe(f1.fresh_wallet);
  });
});

describe("REV-01 authority recheck ordering", () => {
  it("a pause before proof release discards the proof; nothing reaches the relayer", async () => {
    await depositAndApprove(world, w, 1_000_000n);
    const id = await prepared("rev-a");
    pauseAgent(ledger(), world.control.env.ws.id, world.control.env.agents.Prince.id, "owner");
    expect(control(id).authorization_state).toBe("rejected");
    const r = await w.funding.release(id, id);
    expect(r.status).toBe("not_ready");
    expect(world.relayer.received).toHaveLength(0);
    expect(w.store.funding(id)!.step).toBe("discarded");
    const input = w.store.funding(id)!.input_note_id;
    expect(w.store.note(input)!.state).toBe("spendable");
    expect(w.store.events(id).map((e) => e.kind)).not.toContain("proof.released");
  });

  it("without control's release_proof record the wallet refuses to release", async () => {
    await depositAndApprove(world, w, 1_000_000n);
    const id = await prepared("rev-b");
    expect((await w.funding.release(id, id)).status).toBe("not_ready");
    expect(world.relayer.received).toHaveLength(0);
  });

  it("a pause after release leaves the proof as live exposure until chain evidence resolves it", async () => {
    await depositAndApprove(world, w, 1_000_000n);
    world.relayer.mode = "hold";
    const id = await prepared("rev-c");
    advanceAuthority(ledger(), id, "release_proof");
    expect((await w.funding.release(id, id)).status).toBe("submitted");
    pauseAgent(ledger(), world.control.env.ws.id, world.control.env.agents.Prince.id, "owner");
    expect(control(id).authorization_state).toBe("released");
    const res = ledger().db.prepare(`SELECT status FROM reservation WHERE purchase_id = ?`).pluck().get(id);
    expect(res).toBe("active");
    expect(w.store.events(id).map((e) => e.kind)).toContain("proof.released");
    // Still within the slot bound: not released.
    expect((await w.funding.status(id)).status).toBe("submitted");
    // Finalized slot past the bound with the nullifier unused: proven unsettled.
    world.chain.slot += 751n;
    const st = await w.funding.status(id);
    expect(st.status).toBe("expired_unsettled");
    expect(w.store.note(w.store.funding(id)!.input_note_id)!.state).toBe("spendable");
    expect(w.store.note(w.store.funding(id)!.change_note_id)!.state).toBe("void");
  });
});

describe("REC-02 lost relayer response", () => {
  it("reconciles the same withdrawal instead of re-proving or re-sending new material", async () => {
    await depositAndApprove(world, w, 1_000_000n);
    world.relayer.mode = "lose_response";
    const id = await prepared("rec2");
    advanceAuthority(ledger(), id, "release_proof");
    const proofsBefore = w.store.funding(id)!.proof_json;
    expect((await w.funding.release(id, id)).status).toBe("uncertain");
    world.relayer.mode = "land";
    const st = await w.funding.status(id);
    expect(st.status).toBe("finalized");
    expect(world.relayer.received).toHaveLength(1);
    expect(w.store.funding(id)!.proof_json).toBe(proofsBefore);
  });

  it("resends the identical request when the relayer never recorded it", async () => {
    await depositAndApprove(world, w, 1_000_000n);
    world.relayer.mode = "down";
    const id = await prepared("rec2b");
    advanceAuthority(ledger(), id, "release_proof");
    expect((await w.funding.release(id, id)).status).toBe("uncertain");
    expect((await w.funding.status(id)).status).toBe("uncertain");
    world.relayer.mode = "land";
    expect((await w.funding.status(id)).status).toBe("submitted");
    expect((await w.funding.status(id)).status).toBe("finalized");
    expect(world.relayer.received).toHaveLength(1);
    const sent = JSON.parse(world.relayer.received[0]!) as { withdrawalId: string };
    expect(sent.withdrawalId).toBe(w.store.funding(id)!.relayer_withdrawal_id);
  });
});

describe("merchant leg and owner recovery (REC-03)", () => {
  async function funded(key: string) {
    await depositAndApprove(world, w, 1_000_000n);
    const id = await prepared(key);
    const fin = await releasedAndFinal(id);
    recordInControl(id, fin);
    return id;
  }

  it("signs once after control's sign_merchant, and a retry returns the stored payment", async () => {
    const id = await funded("m1");
    const body = { fundingRef: id, paymentRequired: {}, binding: BINDING, exactAmountUsdc: 100_000n };
    expect((await w.funding.signMerchant(id, body)).status).toBe("not_ready");
    advanceAuthority(ledger(), id, "sign_merchant");
    const a = await w.funding.signMerchant(id, body);
    const b = await w.funding.signMerchant(id, body);
    expect(a.status).toBe("signed");
    expect(b).toEqual(a);
    expect(world.merchant.calls).toBe(1);
    expect((await w.funding.signMerchant(id, { ...body, exactAmountUsdc: 99n })).status).toBe("signed");
  });

  it("refuses a changed binding or amount before signing", async () => {
    const id = await funded("m2");
    advanceAuthority(ledger(), id, "sign_merchant");
    const body = { fundingRef: id, paymentRequired: {}, binding: BINDING, exactAmountUsdc: 100_000n };
    expect((await w.funding.signMerchant(id, { ...body, exactAmountUsdc: 99n })).status).toBe("recovery_required");
    expect((await w.funding.signMerchant(id, { ...body, binding: { ...BINDING, payTo: "Other" } })).status).toBe("recovery_required");
    expect(world.merchant.calls).toBe(0);
  });

  it("waits while a signed merchant payment could settle, then recovers only to the owner account", async () => {
    const id = await funded("m3");
    advanceAuthority(ledger(), id, "sign_merchant");
    world.chain.validBlockhashes.add(world.merchant.blockhash);
    await w.funding.signMerchant(id, { fundingRef: id, paymentRequired: {}, binding: BINDING, exactAmountUsdc: 100_000n });
    await expect(w.owner.prepareRecovery(id)).rejects.toMatchObject({ code: "SETTLEMENT_UNCERTAIN" });
    expect(control(id).recovery_state).toBe("none");

    // Blockhash expired and no transaction with that message exists: proven unsettled.
    world.chain.validBlockhashes.delete(world.merchant.blockhash);
    const plan = (await w.owner.prepareRecovery(id)) as { recoveryId: string; destinationOwner: string; rentDestination: string; amount: { amount: string } };
    expect(plan.destinationOwner).toBe(world.recoveryOwner);
    expect(plan.rentDestination).toBe(world.ctx.sponsor);
    expect(plan.amount.amount).toBe("100000");
    expect(control(id).merchant_state).toBe("expired_unsettled");
    expect(control(id).recovery_state).toBe("recoverable");

    const dest = await freshAta(world, world.recoveryOwner);
    world.chain.accounts.set(dest, { data: new Uint8Array(165), lamports: 1n, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" });
    const sub = (await w.owner.confirmRecovery(plan.recoveryId)) as { signature: string; state: string };
    expect(sub.state).toBe("submitted");
    const req = JSON.parse(world.relayer.received.at(-1)!) as { transaction: string; destinationAta: string };
    expect(req.destinationAta).toBe(dest);
    const tx = decodeWireTransaction(req.transaction);
    const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    expect(msg.staticAccounts[0]).toBe(world.ctx.sponsor);
    const close = msg.instructions.at(-1)!;
    expect(new Uint8Array(close.data!)[0]).toBe(9);
    expect(msg.staticAccounts[close.accountIndices![1]!]).toBe(world.ctx.sponsor);

    world.chain.finalize(sub.signature);
    const done = (await w.owner.reconcileRecovery(w.store.recovery(plan.recoveryId)!)) as { state: string };
    expect(done.state).toBe("finalized");
    expect(control(id).recovery_state).toBe("recovered");
    const kinds = w.store.events(plan.recoveryId).map((e) => e.kind);
    expect(kinds).toContain("recovery.principal_recovered");
    expect(kinds).toContain("recovery.rent_returned_to_sponsor");
    // External recovery creates no pool note.
    const buckets = tokenBuckets(ledger(), world.control.env.ws.id);
    expect(buckets.external_recovered).toBe(100_000n);
    expect(ledger().db.prepare(`SELECT count(*) FROM note`).pluck().get()).toBe(2n);
  });
});

describe("owner public exit (original and change notes)", () => {
  it("builds exit_public for the original note, signed by the refund authority only", async () => {
    await depositAndApprove(world, w, 500_000n);
    const owner = address(world.control.env.owner.address);
    const noteId = w.store.notes()[0]!.id;
    await expect(w.owner.prepareExit(address(world.recoveryOwner), noteId)).rejects.toMatchObject({ code: "POLICY_DENIED" });
    const ex = (await w.owner.prepareExit(owner, noteId)) as { transaction: string; privacyWarning: string; noteOrigin: string };
    expect(ex.privacyWarning).toMatch(/linkable/);
    const msg = getCompiledTransactionMessageDecoder().decode(decodeWireTransaction(ex.transaction).messageBytes);
    expect(msg.staticAccounts[0]).toBe(owner);
    const ix = msg.instructions.find((i) => msg.staticAccounts[i.programAddressIndex] === world.ctx.programId)!;
    expect(Array.from(new Uint8Array(ix.data!).subarray(0, 8))).toEqual(Array.from(instructionDiscriminator("exit_public")));
    expect(w.store.note(noteId)!.state).toBe("exit_prepared");
  });

  it("exits a change note under the original label and records it in control", async () => {
    await depositAndApprove(world, w, 1_000_000n);
    const id = await prepared("exit-change");
    const fin = await releasedAndFinal(id);
    recordInControl(id, fin);
    world.pool.insertAll();
    await w.notes.sync();
    const changeId = w.store.funding(id)!.change_note_id;
    const owner = address(world.control.env.owner.address);
    const ex = (await w.owner.prepareExit(owner, changeId)) as { exitId: string; noteOrigin: string };
    expect(ex.noteOrigin).toBe("change");
    w.owner.registerExit(owner, ex.exitId, randomSignature());
    const note = w.store.note(changeId)!;
    await world.pool.exit(BigInt(`0x${w.store.exit(ex.exitId)!.nullifier_hash}`), note.label, note.value);
    await w.notes.sync();
    expect(w.store.note(changeId)!.state).toBe("exited");
    expect(ledger().db.prepare(`SELECT state FROM note WHERE commitment = ?`).pluck().get(note.commitment)).toBe("exited");
  });
});

describe("SEC-02 relayer and logs never receive note secrets", () => {
  it("scans every relayer request, the control ledger and the wallet journal for secret values", async () => {
    await depositAndApprove(world, w, 1_000_000n);
    const id = await prepared("sec");
    await releasedAndFinal(id);
    const secrets: string[] = [];
    for (const n of w.store.notes()) {
      secrets.push(n.nullifierSecret.toString(), n.noteSecret.toString(), n.nullifierSecret.toString(16), n.noteSecret.toString(16));
      if (n.salt) secrets.push(Buffer.from(n.salt).toString("hex"), Buffer.from(n.salt).toString("base64"));
    }
    const { seed } = w.store.freshWalletSeed(id);
    secrets.push(Buffer.from(seed).toString("hex"), Buffer.from(seed).toString("base64"));
    secrets.push(readFileSync(join(world.dir, "owner-service.secret"), "utf8").trim().split(":")[1]!);
    const haystacks = [
      ...world.relayer.received,
      JSON.stringify(w.store.events(), (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
      JSON.stringify(w.store.db.prepare(`SELECT * FROM funding`).all(), (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
      ...["audit_event", "outbox", "note", "token_event", "purchase"].map((t) =>
        JSON.stringify(ledger().db.prepare(`SELECT * FROM ${t}`).all(), (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
      ),
    ];
    for (const h of haystacks) for (const s of secrets) expect(h.includes(s), `secret leaked`).toBe(false);
    // The strict relayer schema rejects a request carrying an extra secret-bearing field.
    const sent = JSON.parse(world.relayer.received[0]!) as Record<string, unknown>;
    const { withdrawalRequestWire } = await import("@veilo/contracts/relayer");
    expect(withdrawalRequestWire.safeParse({ ...sent, nullifierSecret: "1" }).success).toBe(false);
    // Encrypted columns do not contain the plaintext secrets either.
    const raw = w.store.db.prepare(`SELECT ciphertext FROM wallet_note`).all() as Array<{ ciphertext: Buffer }>;
    for (const r of raw) for (const s of secrets) expect(r.ciphertext.toString("latin1").includes(s)).toBe(false);
  });
});
