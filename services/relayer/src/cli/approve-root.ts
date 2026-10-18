// Approved-root operator tool. Applies the published prototype approval rule to the replayed
// pool state, writes the ordered approved-label list, and (only with --key <path> --confirm)
// signs update_approved_root with the approval authority. Without --confirm it changes nothing
// on chain. Key contents are never printed.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { address, isAddress } from "@solana/kit";
import { VeiloConfigError, findRepoRoot, loadConfig, loadDotEnv } from "@veilo/contracts";
import { PROTOTYPE_APPROVAL_RULE } from "@veilo/contracts/relayer";
import { buildApprovedTree, getPoseidon, updateApprovedRootInstruction, type PoolReplay } from "@veilo/privacy-sdk";
import { createRpcRelayerChain } from "../chain";
import { openRelayerDb } from "../db";
import { verifyDeployment } from "../deployment";
import { Indexer, readApprovedLabels, type ApprovedLabelsFile } from "../indexer";
import { loadSponsorKey, sponsorSignedTx } from "../sponsor";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

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

async function main(): Promise<void> {
  const rootDir = findRepoRoot();
  loadDotEnv({ rootDir });
  const config = loadConfig(process.env, { rootDir });
  const participants = new Set((arg("--participants") ?? process.env.APPROVED_PARTICIPANTS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  for (const p of participants) if (!isAddress(p)) throw new VeiloConfigError("INVALID_CONFIG", "participants must be base58 addresses");
  if (participants.size === 0) throw new VeiloConfigError("INVALID_CONFIG", "pass --participants <addr,...> (synthetic/test participants only)");
  const chain = createRpcRelayerChain(config.network.rpcUrl);
  const deployment = await verifyDeployment({ manifestPath: config.pool.deploymentManifestPath, repoRoot: rootDir, programId: config.pool.programId, poolId: config.pool.poolId, mint: config.network.mint, chain });
  if (deployment.state !== "verified") throw new VeiloConfigError("INVALID_CONFIG", `deployment not verified: ${deployment.reason}`);
  const m = deployment.manifest;
  const out = arg("--out") !== undefined ? resolve(arg("--out")!) : resolve(rootDir, process.env.APPROVED_LABELS_PATH?.trim() || join("artifacts", "deployment", "approved-labels.json"));
  const p = await getPoseidon();
  const db = openRelayerDb(process.env.RELAYER_DATABASE_PATH?.trim() || join(config.paths.dataDir, "relayer.sqlite"));
  const indexer = new Indexer(db, chain, p, address(m.program.programId), address(m.pool.poolState), address(m.pool.approvalState), out);
  const { replay } = await indexer.replay();
  const previous = (readApprovedLabels(out, m.pool.poolState)?.labels ?? []).map(BigInt);
  const labels = applyApprovalRule(replay, participants, previous);
  const root = buildApprovedTree(p, labels).root;
  console.log(`approval rule: ${PROTOTYPE_APPROVAL_RULE}`);
  console.log(`approved labels: ${labels.length} (${labels.length - previous.length} new); root ${root}`);
  if (root === replay.approvedRoot) {
    console.log("on-chain approved root already matches; nothing to do");
    return;
  }
  const file: ApprovedLabelsFile = { schema: "veilo-approved-labels-v1", pool: m.pool.poolState, rule: PROTOTYPE_APPROVAL_RULE, labels: labels.map(String), root: root.toString() };
  if (!process.argv.includes("--confirm")) {
    console.log("dry run: rerun with --key <approval-authority-keypair> --confirm to publish the list and update the on-chain root");
    return;
  }
  // pnpm runs this from services/relayer; a relative --key is meant from the repository root, like APPROVED_LABELS_PATH.
  const keyPath = arg("--key") !== undefined ? resolve(rootDir, arg("--key")!) : undefined;
  if (keyPath !== undefined && !existsSync(keyPath)) throw new VeiloConfigError("INVALID_CONFIG", "--key file is missing");
  const key = await loadSponsorKey(keyPath);
  if (!key || key.address !== m.authorities.approvalAuthority) throw new VeiloConfigError("INVALID_CONFIG", "--key must be the manifest approval authority keypair");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
  const ix = updateApprovedRootInstruction(address(m.program.programId), { approvalAuthority: key.address, poolState: address(m.pool.poolState), approvalState: address(m.pool.approvalState) }, root);
  const signed = await sponsorSignedTx(key, await chain.latestBlockhash(), [ix]);
  console.log(`published ${out}; submitting update_approved_root (signature ${signed.signature}, valid until block height ${signed.lastValidBlockHeight})`);
  await chain.send(signed.wire);
}

if (process.argv[1]?.endsWith("approve-root.ts")) {
  main().catch((error: unknown) => {
    console.error(`${(error as Error).name}: ${(error as Error).message}`);
    process.exit(1);
  });
}
