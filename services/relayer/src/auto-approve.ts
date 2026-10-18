import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { address } from "@solana/kit";
import { PROTOTYPE_APPROVAL_RULE } from "@veilo/contracts/relayer";
import { buildApprovedTree, updateApprovedRootInstruction, type DeploymentManifest, type PoolReplay } from "@veilo/privacy-sdk";
import type { RelayerChain } from "./chain";
import { readApprovedLabels, type ApprovedLabelsFile, type Indexer } from "./indexer";
import { sponsorSignedTx, type SponsorKey } from "./sponsor";

/**
 * The prototype rule: labels of inserted (finalized) deposits whose refund authority is one of
 * the configured synthetic/test participants. Previously approved labels keep their positions.
 */
export function applyApprovalRule(replay: PoolReplay, participants: ReadonlySet<string>, previous: readonly bigint[]): bigint[] {
  const out = [...previous];
  const seen = new Set(previous);
  const ordered = [...replay.deposits.values()].sort((a, b) => (a.queueSeq < b.queueSeq ? -1 : 1));
  for (const d of ordered) {
    if (d.state !== "inserted" || !participants.has(d.refundAuthority) || seen.has(d.label)) continue;
    out.push(d.label);
    seen.add(d.label);
  }
  return out;
}

/** A submitted root is not resubmitted while its transaction can still land. */
const RESUBMIT_AFTER_MS = 90_000;

/**
 * Applies the same rule as the approve-root operator tool on every relayer tick, so an inserted
 * deposit from a configured participant becomes spendable without a manual step. It signs only
 * update_approved_root with the manifest's approval authority and compares against the on-chain
 * root, so a list written to disk whose transaction never landed is published again.
 */
export class AutoApprover {
  #pending: { root: bigint; at: number } | null = null;

  constructor(
    private readonly o: {
      indexer: Indexer;
      chain: Pick<RelayerChain, "latestBlockhash" | "send">;
      poseidon: Parameters<typeof buildApprovedTree>[0];
      manifest: DeploymentManifest;
      key: SponsorKey;
      participants: ReadonlySet<string>;
      labelsPath: string;
      now?: () => number;
      log?: (line: string) => void;
    },
  ) {
    if (o.key.address !== o.manifest.authorities.approvalAuthority) throw new Error("the auto-approval key is not the manifest approval authority");
  }

  /** Returns the published root, or null when the on-chain root already covers every eligible label. */
  async tick(): Promise<bigint | null> {
    const { indexer, manifest: m, key, participants, labelsPath } = this.o;
    const now = (this.o.now ?? Date.now)();
    const { replay } = await indexer.replay();
    const previous = (readApprovedLabels(labelsPath, m.pool.poolState)?.labels ?? []).map(BigInt);
    const labels = applyApprovalRule(replay, participants, previous);
    const root = buildApprovedTree(this.o.poseidon, labels).root;
    if (root === replay.approvedRoot) {
      this.#pending = null;
      return null;
    }
    if (this.#pending && this.#pending.root === root && now - this.#pending.at < RESUBMIT_AFTER_MS) return null;
    const file: ApprovedLabelsFile = { schema: "veilo-approved-labels-v1", pool: m.pool.poolState, rule: PROTOTYPE_APPROVAL_RULE, labels: labels.map(String), root: root.toString() };
    mkdirSync(dirname(labelsPath), { recursive: true });
    writeFileSync(labelsPath, `${JSON.stringify(file, null, 2)}\n`);
    const ix = updateApprovedRootInstruction(address(m.program.programId), { approvalAuthority: key.address, poolState: address(m.pool.poolState), approvalState: address(m.pool.approvalState) }, root);
    const signed = await sponsorSignedTx(key, await this.o.chain.latestBlockhash(), [ix]);
    this.#pending = { root, at: now };
    await this.o.chain.send(signed.wire);
    this.o.log?.(`approved ${labels.length - previous.length} new deposit label(s); update_approved_root ${signed.signature}`);
    return root;
  }
}
