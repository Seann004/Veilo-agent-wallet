// Publishes the approved-label list for inserted deposits by the configured synthetic/test
// participants (the prototype approval rule) and updates the on-chain approved root with the
// approval authority. Shared by the local stack and demo:run; signs only when called.
import { join } from "node:path";
import { address } from "@solana/kit";
import { PROTOTYPE_APPROVAL_RULE } from "@veilo/contracts/relayer";
import { buildApprovedTree, getPoseidon, updateApprovedRootInstruction, type DeploymentManifest } from "../../packages/privacy-sdk/src/index";
import { applyApprovalRule } from "../../services/relayer/src/cli/approve-root";
import { createRpcRelayerChain } from "../../services/relayer/src/chain";
import { openRelayerDb } from "../../services/relayer/src/db";
import { Indexer, readApprovedLabels } from "../../services/relayer/src/indexer";
import { awaitTx, computeUnitLimitIx, loadSigner, signAndSend, writeJson, type Rpc, type SentTx } from "../devnet/lib";

export interface ApproveOptions {
  rpc: Rpc;
  rpcUrl: string;
  manifest: DeploymentManifest;
  labelsPath: string;
  participants: ReadonlySet<string>;
  approvalKeyPath: string;
  /** Scratch indexer database (replay cache). */
  workDir: string;
  /** Persists the signature before the transaction is sent. */
  onSent?: (s: SentTx) => void;
}

/** Returns the update signature, or null when the on-chain root already covers every eligible label. */
export async function approveInsertedDeposits(o: ApproveOptions): Promise<{ signature: string | null; labels: number }> {
  const poseidon = await getPoseidon();
  const db = openRelayerDb(join(o.workDir, "approve-root.sqlite"));
  try {
    const m = o.manifest;
    const indexer = new Indexer(db, createRpcRelayerChain(o.rpcUrl), poseidon, address(m.program.programId), address(m.pool.poolState), address(m.pool.approvalState), o.labelsPath);
    const { replay } = await indexer.replay();
    const previous = (readApprovedLabels(o.labelsPath, m.pool.poolState)?.labels ?? []).map(BigInt);
    const labels = applyApprovalRule(replay, o.participants, previous);
    const root = buildApprovedTree(poseidon, labels).root;
    if (root === replay.approvedRoot) return { signature: null, labels: labels.length };
    const signer = await loadSigner(o.approvalKeyPath, m.authorities.approvalAuthority);
    writeJson(o.labelsPath, { schema: "veilo-approved-labels-v1", pool: m.pool.poolState, rule: PROTOTYPE_APPROVAL_RULE, labels: labels.map(String), root: root.toString() });
    const ix = updateApprovedRootInstruction(address(m.program.programId), { approvalAuthority: signer.address, poolState: address(m.pool.poolState), approvalState: address(m.pool.approvalState) }, root);
    const sent = await signAndSend(o.rpc, signer, [], [computeUnitLimitIx(100_000), ix], (s) => o.onSent?.(s));
    const r = await awaitTx(o.rpc, sent, 180_000);
    if (r.state !== "finalized" || r.outcome.err !== null) throw new Error(`update_approved_root ${sent.signature}: ${r.state}`);
    return { signature: sent.signature, labels: labels.length };
  } finally {
    db.close();
  }
}
