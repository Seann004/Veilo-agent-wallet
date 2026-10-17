import type { Address } from "@solana/kit";
import { EncodingError } from "./field";
import type { Poseidon } from "./poseidon";
import type { ApprovalStateAccount, PoolEvent, PoolStateAccount } from "./program";
import { APPROVED_TREE_DEPTH, MerkleTree, TREE_DEPTH, zeroValues, type MerklePath } from "./tree";

export const ROOT_HISTORY = 32;

export class ReplayMismatchError extends Error {
  override readonly name = "ReplayMismatchError";
}

export interface ReplayedDeposit {
  queueSeq: bigint;
  amount: bigint;
  refundAuthority: Address;
  salt: Uint8Array;
  label: bigint;
  precommitment: bigint;
  commitment: bigint;
  state: "pending" | "inserted" | "refunded" | "skipped";
  leafIndex: number | null;
}

export interface ReplayedChange {
  queueSeq: bigint;
  nullifierHash: bigint;
  commitment: bigint;
  state: "pending" | "inserted";
  leafIndex: number | null;
}

export interface ReplayedLeaf {
  index: number;
  commitment: bigint;
  kind: "deposit" | "change";
  queueSeq: bigint;
}

/**
 * Rebuilds the pool's public state from its finalized events, in order. Every transition is
 * checked against the program's rules (queue order, leaf order, the root the program
 * accepted), so a gap, reordering or forged event stops the replay instead of producing a
 * tree that disagrees with the chain.
 */
export class PoolReplay {
  readonly tree: MerkleTree;
  readonly deposits = new Map<bigint, ReplayedDeposit>();
  readonly changes = new Map<bigint, ReplayedChange>();
  readonly leaves: ReplayedLeaf[] = [];
  readonly nullifiers = new Map<bigint, "spend" | "exit">();
  readonly spends: Array<Extract<PoolEvent, { name: "PrivateSpend" }>> = [];
  readonly exits: Array<Extract<PoolEvent, { name: "PublicExit" }>> = [];
  readonly roots: bigint[];
  queueHead = 0n;
  queueTail = 0n;
  liability = 0n;
  approvedRoot: bigint;
  approvedVersion = 0n;
  initialized = false;
  eventsApplied = 0;

  constructor(
    private readonly p: Poseidon,
    readonly pool: Address,
  ) {
    this.tree = new MerkleTree(p, TREE_DEPTH);
    const empty = this.tree.root;
    this.roots = [empty];
    this.approvedRoot = empty;
  }

  private fail(msg: string): never {
    throw new ReplayMismatchError(msg);
  }

  private sub(a: bigint, b: bigint, what: string): bigint {
    if (b > a) this.fail(`${what} underflows liability`);
    return a - b;
  }

  private pushRoot(root: bigint): void {
    this.roots.push(root);
    if (this.roots.length > ROOT_HISTORY) this.roots.shift();
  }

  get currentRoot(): bigint {
    return this.tree.root;
  }

  isKnownRoot(root: bigint): boolean {
    return this.roots.includes(root);
  }

  apply(ev: PoolEvent): void {
    if (ev.pool !== this.pool) this.fail(`event ${ev.name} belongs to another pool`);
    if (!this.initialized && ev.name !== "PoolInitialized") this.fail(`event ${ev.name} before PoolInitialized`);
    switch (ev.name) {
      case "PoolInitialized": {
        if (this.initialized) this.fail("pool initialized twice");
        if (ev.emptyRoot !== zeroValues(this.p, TREE_DEPTH)[TREE_DEPTH]) this.fail("pool empty root differs from Z[16]");
        this.initialized = true;
        break;
      }
      case "DepositQueued": {
        if (ev.queueSeq !== this.queueTail) this.fail(`deposit queue_seq ${ev.queueSeq} != tail ${this.queueTail}`);
        const expected = this.p.h3(ev.amount, ev.label, ev.precommitment);
        if (expected !== ev.commitment) this.fail("deposit commitment is not H3(amount, label, precommitment)");
        this.liability += ev.amount;
        if (this.liability !== ev.liability) this.fail("deposit liability mismatch");
        this.deposits.set(ev.queueSeq, {
          queueSeq: ev.queueSeq,
          amount: ev.amount,
          refundAuthority: ev.refundAuthority,
          salt: ev.salt,
          label: ev.label,
          precommitment: ev.precommitment,
          commitment: ev.commitment,
          state: "pending",
          leafIndex: null,
        });
        this.queueTail += 1n;
        break;
      }
      case "DepositRefunded": {
        const d = this.deposits.get(ev.queueSeq);
        if (!d || d.state !== "pending") this.fail(`refund of non-pending deposit ${ev.queueSeq}`);
        if (d.amount !== ev.amount || d.refundAuthority !== ev.refundAuthority) this.fail("refund differs from the deposit record");
        d.state = "refunded";
        this.liability = this.sub(this.liability, ev.amount, "refund");
        if (this.liability !== ev.liability) this.fail("refund liability mismatch");
        break;
      }
      case "QueueItemSkipped": {
        if (ev.queueSeq !== this.queueHead) this.fail("skip is not at the queue head");
        const d = this.deposits.get(ev.queueSeq);
        if (!d || d.state !== "refunded") this.fail("skipped item is not a refunded deposit");
        d.state = "skipped";
        this.queueHead += 1n;
        break;
      }
      case "LeafInserted": {
        if (ev.queueSeq !== this.queueHead) this.fail(`insert of queue_seq ${ev.queueSeq} but head is ${this.queueHead}`);
        if (ev.leafIndex !== BigInt(this.tree.size)) this.fail(`leaf index ${ev.leafIndex} != next ${this.tree.size}`);
        const rec = ev.kind === "deposit" ? this.deposits.get(ev.queueSeq) : this.changes.get(ev.queueSeq);
        if (!rec || rec.state !== "pending") this.fail(`inserted ${ev.kind} record ${ev.queueSeq} is not pending`);
        if (rec.commitment !== ev.commitment) this.fail("inserted leaf differs from its queue record");
        const index = this.tree.append(ev.commitment);
        if (this.tree.root !== ev.newRoot) this.fail(`replayed root differs from the root accepted at leaf ${index}`);
        rec.state = "inserted";
        rec.leafIndex = index;
        this.leaves.push({ index, commitment: ev.commitment, kind: ev.kind, queueSeq: ev.queueSeq });
        this.pushRoot(ev.newRoot);
        this.queueHead += 1n;
        break;
      }
      case "PrivateSpend": {
        if (this.nullifiers.has(ev.nullifierHash)) this.fail("nullifier spent twice");
        if (!this.isKnownRoot(ev.stateRoot)) this.fail("spend used a root outside the replayed history");
        if (ev.approvedRoot !== this.approvedRoot) this.fail("spend used a non-current approved root");
        if (ev.payoutAmount + ev.relayerFee !== ev.withdrawnValue) this.fail("spend debit mismatch");
        if (ev.changeQueueSeq !== this.queueTail) this.fail("change queue_seq != tail");
        this.nullifiers.set(ev.nullifierHash, "spend");
        this.spends.push(ev);
        this.changes.set(ev.changeQueueSeq, {
          queueSeq: ev.changeQueueSeq,
          nullifierHash: ev.nullifierHash,
          commitment: ev.newCommitment,
          state: "pending",
          leafIndex: null,
        });
        this.queueTail += 1n;
        this.liability = this.sub(this.liability, ev.withdrawnValue, "spend");
        if (this.liability !== ev.liability) this.fail("spend liability mismatch");
        break;
      }
      case "PublicExit": {
        if (this.nullifiers.has(ev.nullifierHash)) this.fail("nullifier spent twice");
        if (!this.isKnownRoot(ev.stateRoot)) this.fail("exit used a root outside the replayed history");
        this.nullifiers.set(ev.nullifierHash, "exit");
        this.exits.push(ev);
        this.liability = this.sub(this.liability, ev.value, "exit");
        if (this.liability !== ev.liability) this.fail("exit liability mismatch");
        break;
      }
      case "ApprovedRootUpdated": {
        if (ev.version !== this.approvedVersion + 1n) this.fail("approved root version gap");
        this.approvedRoot = ev.approvedRoot;
        this.approvedVersion = ev.version;
        break;
      }
      case "ConfigUpdated":
        break;
    }
    this.eventsApplied += 1;
  }

  /** Differences between the replay and finalized on-chain accounts; empty means consistent. */
  compare(pool: PoolStateAccount, approval: ApprovalStateAccount | null): string[] {
    const out: string[] = [];
    if (pool.currentRoot !== this.currentRoot) out.push("current_root");
    if (pool.nextLeafIndex !== BigInt(this.tree.size)) out.push("next_leaf_index");
    if (pool.queueHead !== this.queueHead) out.push("queue_head");
    if (pool.queueTail !== this.queueTail) out.push("queue_tail");
    if (pool.liability !== this.liability) out.push("liability");
    if (pool.rootsLen !== this.roots.length) out.push("roots_len");
    const onchain = new Set(pool.rootHistory.slice(0, pool.rootsLen));
    if (this.roots.some((r) => !onchain.has(r))) out.push("root_history");
    if (approval) {
      if (approval.approvedRoot !== this.approvedRoot) out.push("approved_root");
      if (approval.version !== this.approvedVersion) out.push("approved_version");
    }
    return out;
  }

  /** Membership path for a leaf, only if it is in the replayed tree. */
  pathFor(commitment: bigint): MerklePath | null {
    const leaf = this.leaves.find((l) => l.commitment === commitment);
    return leaf ? this.tree.path(leaf.index) : null;
  }

  depositByCommitment(commitment: bigint): ReplayedDeposit | undefined {
    for (const d of this.deposits.values()) if (d.commitment === commitment) return d;
    return undefined;
  }

  /** The next queue record to insert, if any. */
  queueHeadRecord(): { kind: "deposit"; record: ReplayedDeposit } | { kind: "change"; record: ReplayedChange } | null {
    const d = this.deposits.get(this.queueHead);
    if (d) return { kind: "deposit", record: d };
    const c = this.changes.get(this.queueHead);
    if (c) return { kind: "change", record: c };
    return null;
  }
}

/** Approved label tree, rebuilt from the operator's published, ordered label list. */
export function buildApprovedTree(p: Poseidon, labels: readonly bigint[]): MerkleTree {
  const tree = new MerkleTree(p, APPROVED_TREE_DEPTH);
  const seen = new Set<bigint>();
  for (const l of labels) {
    if (l === 0n) throw new EncodingError("approved labels are nonzero");
    if (seen.has(l)) throw new EncodingError("approved labels must be unique");
    seen.add(l);
    tree.append(l);
  }
  return tree;
}

export function approvedPathFor(tree: MerkleTree, label: bigint): MerklePath | null {
  for (let i = 0; i < tree.size; i++) if (tree.leaf(i) === label) return tree.path(i);
  return null;
}
