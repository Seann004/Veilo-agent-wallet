import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "@solana/kit";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApprovedTree, MerkleTree, PoolReplay, type DeploymentManifest, type Poseidon } from "@veilo/privacy-sdk";
import { AutoApprover } from "../src/auto-approve";
import type { Indexer } from "../src/indexer";
import type { SponsorKey } from "../src/sponsor";
import { poseidon, randomAddress, testManifest, testSponsor } from "./fixtures";

let p: Poseidon;
let dir: string;
beforeAll(async () => {
  p = await poseidon();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function setup() {
  dir = mkdtempSync(join(tmpdir(), "veilo-autoapprove-"));
  const key: SponsorKey = await testSponsor();
  const m: DeploymentManifest = await testManifest(randomAddress());
  m.authorities.approvalAuthority = key.address;
  const pool = m.pool.poolState as Address;
  const r = new PoolReplay(p, pool);
  r.apply({ name: "PoolInitialized", pool, poolId: new Uint8Array(32), mint: randomAddress(), tokenProgram: randomAddress(), vault: randomAddress(), genesisHash: new Uint8Array(32), emptyRoot: new MerkleTree(p).root, configAuthority: randomAddress(), approvalAuthority: key.address, protocolVersion: 1 });
  const tree = new MerkleTree(p);
  let liability = 0n;
  const deposit = (seq: bigint, who: Address, label: bigint, insert: boolean) => {
    liability += 100_000n;
    const commitment = p.h3(100_000n, label, 7n);
    r.apply({ name: "DepositQueued", pool, queueSeq: seq, amount: 100_000n, refundAuthority: who, salt: new Uint8Array(32), label, precommitment: 7n, commitment, liability });
    if (insert) {
      tree.append(commitment);
      r.apply({ name: "LeafInserted", pool, queueSeq: seq, kind: "deposit", leafIndex: BigInt(tree.size - 1), commitment, newRoot: tree.root });
    }
  };
  const sent: string[] = [];
  const chain = { latestBlockhash: async () => ({ blockhash: randomAddress() as string, lastValidBlockHeight: 200n }), send: async (wire: string) => void sent.push(wire) };
  const indexer = { replay: async () => ({ replay: r }) } as unknown as Indexer;
  let t = 1_000;
  const labelsPath = join(dir, "approved-labels.json");
  const owner = randomAddress();
  const approver = new AutoApprover({ indexer, chain, poseidon: p, manifest: m, key, participants: new Set([owner]), labelsPath, now: () => t });
  return { r, deposit, sent, approver, owner, labelsPath, advance: (ms: number) => (t += ms) };
}

describe("relayer auto-approval", () => {
  it("approves an inserted deposit from a configured participant once, and ignores everyone else", async () => {
    const s = await setup();
    s.deposit(0n, s.owner, 11n, true);
    s.deposit(1n, randomAddress(), 22n, true);
    s.deposit(2n, s.owner, 33n, false);
    const root = await s.approver.tick();
    expect(root).toBe(buildApprovedTree(p, [11n]).root);
    expect(s.sent).toHaveLength(1);
    expect(JSON.parse(readFileSync(s.labelsPath, "utf8")).labels).toEqual(["11"]);
    // Not landed yet: no resubmission inside the window.
    expect(await s.approver.tick()).toBeNull();
    expect(s.sent).toHaveLength(1);
  });

  it("resubmits a root whose transaction never landed, and stops once the chain matches", async () => {
    const s = await setup();
    s.deposit(0n, s.owner, 11n, true);
    const root = await s.approver.tick();
    s.advance(91_000);
    expect(await s.approver.tick()).toBe(root);
    expect(s.sent).toHaveLength(2);
    s.r.approvedRoot = root!;
    expect(await s.approver.tick()).toBeNull();
    expect(s.sent).toHaveLength(2);
  });

  it("refuses a key that is not the manifest approval authority", async () => {
    const s = await setup();
    const other = await testSponsor();
    const m = await testManifest(randomAddress());
    expect(() => new AutoApprover({ indexer: {} as Indexer, chain: { latestBlockhash: async () => ({ blockhash: "", lastValidBlockHeight: 0n }), send: async () => undefined }, poseidon: p, manifest: m, key: other, participants: new Set([s.owner]), labelsPath: s.labelsPath })).toThrow(/approval authority/);
  });
});
