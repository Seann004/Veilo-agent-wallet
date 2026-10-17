import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { address, getCompiledTransactionMessageDecoder } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { advanceAuthority } from "@veilo/control/src/ledger/purchases";
import { parseDecimal, verifyProof } from "@veilo/privacy-sdk";
import { decodeWireTransaction } from "@veilo/x402-client";
import type { VerificationKey } from "snarkjs";
import { SnarkjsProver } from "../src/adapters";
import { authorize, createWorld, depositAndApprove, fundingInput, type TestWallet, type World } from "./harness";

const REPO = resolve(import.meta.dirname, "../../..");
const prover = new SnarkjsProver(REPO);
const vk = (name: string) => JSON.parse(readFileSync(join(REPO, "artifacts", "circuits", `${name}.vkey.json`), "utf8")) as VerificationKey;

let world: World;
let w: TestWallet;
beforeEach(async () => {
  world = await createWorld();
  w = world.open();
  w.deps.prover = prover;
});
afterEach(() => world.cleanup());

describe.skipIf(!prover.available() || !existsSync(join(REPO, "circuits", "build")))("real proofs from the replayed tree (requires circuits/build)", () => {
  it("spend proof for an original note verifies against the pinned spend key and matches the relayer request", async () => {
    await depositAndApprove(world, w, 1_000_000n);
    const p = authorize(world, "real-1");
    advanceAuthority(world.control.env.ledger, p.id, "prepare_proof");
    expect((await w.funding.prepare(fundingInput(world, p.id))).status).toBe("prepared");
    const stored = JSON.parse(w.store.funding(p.id)!.proof_json) as { proof: never; publicSignals: string[] };
    expect(await verifyProof(vk("spend"), stored.publicSignals, stored.proof)).toBe(true);
    // stateRoot is the finalized on-chain root; approvedRoot the current approved root.
    expect(parseDecimal(stored.publicSignals[1]!)).toBe(world.pool.tree.root);
    advanceAuthority(world.control.env.ledger, p.id, "release_proof");
    await w.funding.release(p.id, p.id);
    const sent = JSON.parse(world.relayer.received[0]!) as { publicSignals: string[]; proof: never };
    expect(sent.publicSignals).toEqual(stored.publicSignals);
    expect(await verifyProof(vk("spend"), sent.publicSignals, sent.proof)).toBe(true);
  }, 60_000);

  it("exit proof for a change note verifies against the pinned exit key", async () => {
    await depositAndApprove(world, w, 1_000_000n);
    const p = authorize(world, "real-2");
    advanceAuthority(world.control.env.ledger, p.id, "prepare_proof");
    await w.funding.prepare(fundingInput(world, p.id));
    advanceAuthority(world.control.env.ledger, p.id, "release_proof");
    await w.funding.release(p.id, p.id);
    expect((await w.funding.status(p.id)).status).toBe("finalized");
    world.pool.insertAll();
    await w.notes.sync();
    const changeId = w.store.funding(p.id)!.change_note_id;
    // Control has not recorded the funding yet, so the change is inserted but not spendable.
    expect(w.store.note(changeId)!.state).toBe("approved");
    let captured: { publicSignals: string[]; proof: never } | null = null;
    w.deps.prover = { prove: async (c, wit) => ((captured = (await prover.prove(c, wit)) as never), captured!) };
    const owner = address(world.control.env.owner.address);
    const ex = (await w.owner.prepareExit(owner, changeId)) as { transaction: string };
    expect(captured).not.toBeNull();
    expect(await verifyProof(vk("exit"), captured!.publicSignals, captured!.proof)).toBe(true);
    expect(parseDecimal(captured!.publicSignals[2]!)).toBe(900_000n);
    const msg = getCompiledTransactionMessageDecoder().decode(decodeWireTransaction(ex.transaction).messageBytes);
    expect(msg.staticAccounts[0]).toBe(owner);
  }, 60_000);
});
