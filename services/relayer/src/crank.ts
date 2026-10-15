import { randomUUID } from "node:crypto";
import { address } from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import {
  insertLeafInstruction,
  insertWitness,
  pendingChangePda,
  pendingDepositPda,
  skipRefundedDepositInstruction,
  toBe32,
  toSolanaProof,
  type CircuitWitness,
  type DeploymentManifest,
  type GeneratedProof,
  type Poseidon,
} from "@veilo/privacy-sdk";
import type { RelayerChain } from "./chain";
import { recordSponsorEvent, sponsorTotals, type RelayerDb } from "./db";
import type { Indexer } from "./indexer";
import { sponsorSignedTx, type SponsorKey } from "./sponsor";
import { LAMPORTS_PER_SIGNATURE } from "./withdrawals";

export interface InsertProver {
  prove(witness: CircuitWitness): Promise<GeneratedProof>;
}

/**
 * Inserts the queue head into the commitment tree with an insert proof built from the
 * replayed tree (no secrets involved), or skips a refunded deposit at the head. One
 * transaction is in flight at a time; its signature and validity are stored before sending.
 */
export class InsertCrank {
  constructor(
    private readonly o: {
      db: RelayerDb;
      chain: RelayerChain;
      indexer: Indexer;
      poseidon: Poseidon;
      sponsor: SponsorKey | null;
      manifest: () => DeploymentManifest | null;
      prover: InsertProver | null;
      sponsorCapLamports: bigint;
    },
  ) {}

  async step(): Promise<string> {
    const { db, chain, sponsor, prover } = this.o;
    const manifest = this.o.manifest();
    if (!manifest || !sponsor || !prover) return "not_ready";
    const inflight = db.prepare(`SELECT * FROM crank_attempt WHERE state = 'submitted' ORDER BY created_at_ms DESC LIMIT 1`).get() as
      | { id: string; signature: string; last_valid_block_height: bigint }
      | undefined;
    if (inflight) {
      const st = await chain.signatureStatus(inflight.signature);
      if (st?.confirmationStatus === "finalized") {
        const tx = await chain.transaction(inflight.signature);
        if (tx) recordSponsorEvent(db, "fee_spent", `crank:${inflight.id}`, inflight.signature, tx.fee);
        db.prepare(`UPDATE crank_attempt SET state = ?, updated_at_ms = ? WHERE id = ?`).run(st.err === null ? "finalized" : "failed", Date.now(), inflight.id);
      } else if (st || (await chain.finalizedBlockHeight()) <= inflight.last_valid_block_height) {
        return "waiting";
      } else {
        db.prepare(`UPDATE crank_attempt SET state = 'expired', updated_at_ms = ? WHERE id = ?`).run(Date.now(), inflight.id);
      }
    }
    const totals = sponsorTotals(db);
    if (totals.feesSpent + totals.rentOutstanding + LAMPORTS_PER_SIGNATURE > this.o.sponsorCapLamports) return "sponsor_cap";
    const { replay } = await this.o.indexer.replay();
    const head = replay.queueHeadRecord();
    if (!head) return "idle";
    const program = address(manifest.program.programId);
    const poolState = address(manifest.pool.poolState);
    let ix;
    let kind: "insert" | "skip";
    if (head.kind === "deposit" && head.record.state === "refunded") {
      ix = skipRefundedDepositInstruction(program, { submitter: sponsor.address, poolState, pendingDeposit: (await pendingDepositPda(program, poolState, head.record.queueSeq)).address });
      kind = "skip";
    } else if (head.record.state === "pending") {
      const path = replay.tree.path(replay.tree.size);
      const w = insertWitness(this.o.poseidon, { path, leaf: head.record.commitment });
      const proof = await prover.prove(w);
      const newRoot = w.publicSignals[1]!;
      ix = insertLeafInstruction(
        program,
        {
          submitter: sponsor.address,
          poolState,
          pendingDeposit: head.kind === "deposit" ? (await pendingDepositPda(program, poolState, head.record.queueSeq)).address : null,
          pendingChange: head.kind === "change" ? (await pendingChangePda(program, poolState, toBe32(head.record.nullifierHash))).address : null,
        },
        { proof: toSolanaProof(proof.proof), newRoot },
      );
      kind = "insert";
    } else {
      return "idle";
    }
    const bh = await chain.latestBlockhash();
    const signed = await sponsorSignedTx(sponsor, bh, [getSetComputeUnitLimitInstruction({ units: 300_000 }), ix]);
    db.prepare(
      `INSERT INTO crank_attempt (id, queue_seq, kind, signature, blockhash, last_valid_block_height, state, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?, ?)`,
    ).run(randomUUID(), head.record.queueSeq, kind, signed.signature, signed.blockhash, signed.lastValidBlockHeight, Date.now(), Date.now());
    await chain.send(signed.wire).catch(() => undefined);
    return kind;
  }
}
