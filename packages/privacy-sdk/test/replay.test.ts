import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddressDecoder } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import {
  approvedPathFor,
  buildApprovedTree,
  getPoseidon,
  parseDecimal,
  PoolReplay,
  ReplayMismatchError,
  rootFromPath,
  type PoolEvent,
  type Poseidon,
} from "../src/index";

interface NoteVector {
  name: string;
  value: string;
  label: string;
  precommitment: string;
  commitment: string;
  nullifierHash: string;
  changes: Array<{ withdrawn: string; commitment: string }>;
}
interface InsertVector {
  queueSeq: number;
  skipped: boolean;
  newRoot?: string;
  root?: string;
  leafIndex?: number;
  leaf?: string;
}
const vectors = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../artifacts/vectors/v1.json"), "utf8")) as {
  note: NoteVector[];
  insert: InsertVector[];
  emptyRoot: string;
  merkle: { approved: { leaves: string[]; root: string }; state: { leaves: string[]; root: string } };
};

const A = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const POOL = A(0x11);
const OWNER = A(0x33);
const d = parseDecimal;

let p: Poseidon;
beforeAll(async () => {
  p = await getPoseidon();
});

function initEvent(): PoolEvent {
  return {
    name: "PoolInitialized",
    pool: POOL,
    poolId: new Uint8Array(32),
    mint: A(0x22),
    tokenProgram: A(0x23),
    vault: A(0x24),
    genesisHash: new Uint8Array(32),
    emptyRoot: d(vectors.emptyRoot),
    configAuthority: A(1),
    approvalAuthority: A(2),
    protocolVersion: 1,
  };
}

/** Events that reproduce the vectors' insert sequence: deposit, refunded+skipped deposit, deposit, change. */
function vectorEvents(): PoolEvent[] {
  const [n0, n1] = vectors.note as [NoteVector, NoteVector];
  const refundedPre = 12345n;
  const refundedLabel = 999n;
  const refundedAmount = 100_000n;
  const refundedCommitment = p.h3(refundedAmount, refundedLabel, refundedPre);
  const ins = vectors.insert;
  const v0 = d(n0.value);
  const v1 = d(n1.value);
  const change = n0.changes[0]!;
  const approvedRoot = 555n;
  let liability = 0n;
  const dep = (seq: bigint, n: { value: bigint; label: bigint; pre: bigint; c: bigint }): PoolEvent => {
    liability += n.value;
    return { name: "DepositQueued", pool: POOL, queueSeq: seq, amount: n.value, refundAuthority: OWNER, salt: new Uint8Array(32), label: n.label, precommitment: n.pre, commitment: n.c, liability };
  };
  const evs: PoolEvent[] = [
    initEvent(),
    dep(0n, { value: v0, label: d(n0.label), pre: d(n0.precommitment), c: d(n0.commitment) }),
    dep(1n, { value: refundedAmount, label: refundedLabel, pre: refundedPre, c: refundedCommitment }),
  ];
  liability -= refundedAmount;
  evs.push({ name: "DepositRefunded", pool: POOL, queueSeq: 1n, amount: refundedAmount, refundAuthority: OWNER, destination: A(0x34), liability });
  evs.push({ name: "LeafInserted", pool: POOL, queueSeq: 0n, kind: "deposit", leafIndex: 0n, commitment: d(n0.commitment), newRoot: d(ins[0]!.newRoot!) });
  evs.push({ name: "QueueItemSkipped", pool: POOL, queueSeq: 1n });
  evs.push(dep(2n, { value: v1, label: d(n1.label), pre: d(n1.precommitment), c: d(n1.commitment) }));
  evs.push({ name: "LeafInserted", pool: POOL, queueSeq: 2n, kind: "deposit", leafIndex: 1n, commitment: d(n1.commitment), newRoot: d(ins[2]!.newRoot!) });
  evs.push({ name: "ApprovedRootUpdated", pool: POOL, version: 1n, approvedRoot });
  liability -= d(change.withdrawn);
  evs.push({
    name: "PrivateSpend",
    pool: POOL,
    nullifierHash: d(n0.nullifierHash),
    stateRoot: d(ins[2]!.newRoot!),
    approvedRoot,
    withdrawnValue: d(change.withdrawn),
    payoutAmount: d(change.withdrawn),
    relayerFee: 0n,
    destinationTokenAccount: A(0x55),
    destinationOwner: A(0x66),
    relayer: null,
    validUntilSlot: 1n,
    newCommitment: d(change.commitment),
    changeQueueSeq: 3n,
    liability,
  });
  evs.push({ name: "LeafInserted", pool: POOL, queueSeq: 3n, kind: "change", leafIndex: 2n, commitment: d(change.commitment), newRoot: d(ins[3]!.newRoot!) });
  return evs;
}

describe("public state replay", () => {
  it("reproduces the vector roots, including a skipped refunded deposit and a change leaf", () => {
    const r = new PoolReplay(p, POOL);
    for (const ev of vectorEvents()) r.apply(ev);
    expect(r.currentRoot).toBe(d(vectors.insert[3]!.newRoot!));
    expect(r.tree.size).toBe(3);
    expect(r.queueHead).toBe(4n);
    expect(r.queueTail).toBe(4n);
    expect(r.deposits.get(1n)!.state).toBe("skipped");
    expect(r.roots).toHaveLength(4);
    // Every replayed path reproduces the current root.
    for (const leaf of r.leaves) {
      const path = r.pathFor(leaf.commitment)!;
      expect(rootFromPath(p, leaf.commitment, path.index, path.siblings)).toBe(r.currentRoot);
    }
  });

  it("refuses a root the replay cannot reproduce (no arbitrary indexer roots)", () => {
    const evs = vectorEvents();
    const forged = evs.map((e) => (e.name === "LeafInserted" && e.queueSeq === 2n ? { ...e, newRoot: e.newRoot + 1n } : e));
    const r = new PoolReplay(p, POOL);
    expect(() => forged.forEach((e) => r.apply(e))).toThrow(ReplayMismatchError);
  });

  it("refuses reordered inserts, double nullifiers and events from another pool", () => {
    const evs = vectorEvents();
    const r1 = new PoolReplay(p, POOL);
    const swapped = [...evs];
    const i = swapped.findIndex((e) => e.name === "QueueItemSkipped");
    [swapped[i - 1], swapped[i]] = [swapped[i]!, swapped[i - 1]!];
    expect(() => swapped.forEach((e) => r1.apply(e))).toThrow(ReplayMismatchError);

    const r2 = new PoolReplay(p, POOL);
    const spend = evs.find((e) => e.name === "PrivateSpend")!;
    expect(() => [...evs, { ...spend, changeQueueSeq: 4n }].forEach((e) => r2.apply(e))).toThrow(/nullifier spent twice/);

    const r3 = new PoolReplay(p, POOL);
    expect(() => r3.apply({ ...initEvent(), pool: A(0x99) })).toThrow(/another pool/);
  });

  it("compares against on-chain accounts and reports each mismatch", () => {
    const r = new PoolReplay(p, POOL);
    for (const ev of vectorEvents()) r.apply(ev);
    const onchain = {
      currentRoot: r.currentRoot,
      nextLeafIndex: 3n,
      queueHead: 4n,
      queueTail: 4n,
      liability: r.liability,
      rootsLen: 4,
      rootHistory: [...r.roots, ...Array(28).fill(0n)],
    };
    const approval = { approvedRoot: 555n, version: 1n };
    expect(r.compare(onchain as never, approval as never)).toEqual([]);
    expect(r.compare({ ...onchain, currentRoot: 1n } as never, { ...approval, approvedRoot: 1n } as never)).toEqual(["current_root", "approved_root"]);
  });

  it("rebuilds the vector approved-label tree", () => {
    const labels = vectors.merkle.approved.leaves.map(d);
    const tree = buildApprovedTree(p, labels);
    expect(tree.root).toBe(d(vectors.merkle.approved.root));
    const path = approvedPathFor(tree, labels[1]!)!;
    expect(rootFromPath(p, labels[1]!, path.index, path.siblings)).toBe(tree.root);
    expect(() => buildApprovedTree(p, [labels[0]!, labels[0]!])).toThrow();
  });
});
