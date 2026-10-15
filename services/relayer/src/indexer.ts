import { existsSync, readFileSync } from "node:fs";
import type { Address } from "@solana/kit";
import { PROTOTYPE_APPROVAL_RULE, type PublicStateWire } from "@veilo/contracts/relayer";
import {
  buildApprovedTree,
  decodeApprovalState,
  decodePoolState,
  parseDecimal,
  parsePoolEventsFromLogs,
  PoolReplay,
  type PoolEvent,
  type Poseidon,
} from "@veilo/privacy-sdk";
import type { RelayerChain } from "./chain";
import type { RelayerDb } from "./db";

/** Operator-published approved label list (the approved tree is rebuilt from it in order). */
export interface ApprovedLabelsFile {
  schema: "veilo-approved-labels-v1";
  pool: string;
  rule: string;
  labels: string[];
  root: string;
}

export function readApprovedLabels(path: string, pool: string): ApprovedLabelsFile | null {
  if (!existsSync(path)) return null;
  const f = JSON.parse(readFileSync(path, "utf8")) as ApprovedLabelsFile;
  if (f.schema !== "veilo-approved-labels-v1" || f.pool !== pool) return null;
  return f;
}

export class IndexerError extends Error {
  override readonly name = "IndexerError";
}

/**
 * Replays the pool's finalized transactions (successful ones only) into public state and
 * compares the result with finalized PoolState/ApprovalState. Transaction logs are cached;
 * the replay itself is rebuilt from the cache on each call.
 */
export class Indexer {
  constructor(
    private readonly db: RelayerDb,
    private readonly chain: RelayerChain,
    private readonly poseidon: Poseidon,
    private readonly program: Address,
    private readonly poolState: Address,
    private readonly approvalState: Address,
    private readonly approvedLabelsPath: string,
  ) {}

  private async events(): Promise<PoolEvent[]> {
    const sigs = await this.chain.signaturesForAddress(this.poolState);
    const cached = this.db.prepare(`SELECT ok, logs_json FROM indexed_tx WHERE signature = ?`);
    const insert = this.db.prepare(`INSERT OR IGNORE INTO indexed_tx (signature, slot, ok, logs_json) VALUES (?, ?, ?, ?)`);
    const out: PoolEvent[] = [];
    for (const s of sigs) {
      let row = cached.get(s.signature) as { ok: bigint; logs_json: string } | undefined;
      if (!row) {
        const tx = await this.chain.transaction(s.signature);
        if (!tx) throw new IndexerError(`finalized transaction ${s.signature} is not retrievable`);
        const ok = tx.err === null ? 1 : 0;
        insert.run(s.signature, tx.slot, ok, JSON.stringify(ok ? tx.logs : []));
        row = { ok: BigInt(ok), logs_json: JSON.stringify(ok ? tx.logs : []) };
      }
      // Rejected or rolled-back transactions never contribute state.
      if (row.ok !== 1n) continue;
      out.push(...parsePoolEventsFromLogs(this.program, JSON.parse(row.logs_json) as string[]));
    }
    return out;
  }

  async replay(): Promise<{ replay: PoolReplay; view: PublicStateWire }> {
    let lastMismatch: string[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const slot = await this.chain.finalizedSlot();
      const replay = new PoolReplay(this.poseidon, this.poolState);
      for (const ev of await this.events()) replay.apply(ev);
      const poolAcct = await this.chain.account(this.poolState);
      const apprAcct = await this.chain.account(this.approvalState);
      if (!poolAcct || !apprAcct) throw new IndexerError("pool accounts are not visible at finalized commitment");
      const pool = decodePoolState(poolAcct.data);
      const approval = decodeApprovalState(apprAcct.data);
      const mismatches = replay.compare(pool, approval);
      lastMismatch = mismatches;
      // A transaction finalized between the reads shows up as a transient mismatch; read again.
      if (mismatches.length > 0) continue;
      const published = readApprovedLabels(this.approvedLabelsPath, this.poolState);
      const labels = published?.labels ?? [];
      const approvedTree = buildApprovedTree(this.poseidon, labels.map(parseDecimal));
      const approvedConsistent = approvedTree.root === approval.approvedRoot;
      const view: PublicStateWire = {
        finalizedSlot: slot.toString(),
        consistent: mismatches.length === 0,
        mismatches,
        pool: {
          poolState: this.poolState,
          currentRoot: pool.currentRoot.toString(),
          knownRoots: pool.rootHistory.slice(0, pool.rootsLen).map(String),
          nextLeafIndex: pool.nextLeafIndex.toString(),
          queueHead: pool.queueHead.toString(),
          queueTail: pool.queueTail.toString(),
          liability: pool.liability.toString(),
          minDeposit: pool.minDeposit.toString(),
          maxDeposit: pool.maxDeposit.toString(),
          maxRelayerFee: pool.maxRelayerFee.toString(),
          depositsPaused: pool.depositsPaused,
        },
        leaves: replay.leaves.map((l) => ({ index: l.index, commitment: l.commitment.toString(), kind: l.kind, queueSeq: l.queueSeq.toString() })),
        deposits: [...replay.deposits.values()].map((d) => ({
          queueSeq: d.queueSeq.toString(),
          commitment: d.commitment.toString(),
          label: d.label.toString(),
          amount: d.amount.toString(),
          refundAuthority: d.refundAuthority,
          state: d.state,
          leafIndex: d.leafIndex,
        })),
        spends: spendsOf(replay),
        exits: exitsOf(replay),
        approved: {
          root: approval.approvedRoot.toString(),
          version: approval.version.toString(),
          labels: approvedConsistent ? labels : [],
          consistent: approvedConsistent,
          rule: published?.rule ?? PROTOTYPE_APPROVAL_RULE,
        },
      };
      return { replay, view };
    }
    throw new IndexerError(`replay disagrees with chain: ${lastMismatch.join(", ")}`);
  }
}

function spendsOf(r: PoolReplay): PublicStateWire["spends"] {
  return r.spends.map((e) => ({
    nullifierHash: e.nullifierHash.toString(),
    newCommitment: e.newCommitment.toString(),
    withdrawnValue: e.withdrawnValue.toString(),
    destinationOwner: e.destinationOwner,
    changeQueueSeq: e.changeQueueSeq.toString(),
  }));
}

function exitsOf(r: PoolReplay): PublicStateWire["exits"] {
  return r.exits.map((e) => ({ nullifierHash: e.nullifierHash.toString(), label: e.label.toString(), value: e.value.toString() }));
}
