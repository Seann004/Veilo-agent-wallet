import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { address } from "@solana/kit";
import {
  VeiloConfigError,
  createServiceHealth,
  describeConfig,
  findRepoRoot,
  loadConfig,
  loadDotEnv,
  startChainGuard,
} from "@veilo/contracts";
import { getPoseidon, prove, sha256Hex, type DeploymentManifest } from "@veilo/privacy-sdk";
import type { VerificationKey } from "snarkjs";
import { createApp } from "./app";
import { createRpcRelayerChain } from "./chain";
import { InsertCrank } from "./crank";
import { openRelayerDb } from "./db";
import { readCircuitPins, verifyDeployment, type DeploymentStatus } from "./deployment";
import { Indexer } from "./indexer";
import { loadSponsorKey } from "./sponsor";
import { SwapService } from "./swaps";
import { RecoveryService, WithdrawalService } from "./withdrawals";

const SERVICE = "relayer";

async function main(): Promise<void> {
  const rootDir = findRepoRoot();
  loadDotEnv({});
  const config = loadConfig(process.env, { rootDir });
  const health = createServiceHealth(SERVICE, config, true);
  startChainGuard(config, health, {
    onMismatch: (error) => {
      console.error(`[${SERVICE}] chain identity check failed (${error.code}): ${error.message}`);
      process.exit(1);
    },
  });
  const chain = createRpcRelayerChain(config.network.rpcUrl);
  const db = openRelayerDb(process.env.RELAYER_DATABASE_PATH?.trim() || join(config.paths.dataDir, "relayer.sqlite"));
  const sponsor = await loadSponsorKey(config.paths.sponsorKey).catch((error: Error) => {
    console.error(`[${SERVICE}] sponsor disabled: ${error.message}`);
    return null;
  });
  const walletPath = config.paths.serviceCredentials.wallet;
  const walletCredentialDigest =
    walletPath !== undefined && existsSync(walletPath) ? createHash("sha256").update(readFileSync(walletPath, "utf8").trim(), "utf8").digest("hex") : null;
  const pins = readCircuitPins(rootDir);
  const vkPath = join(rootDir, "artifacts", "circuits", "spend.vkey.json");
  const vkBytes = readFileSync(vkPath);
  if (sha256Hex(new Uint8Array(vkBytes)) !== pins.circuits.spend.vkeyJsonSha256) {
    console.error(`[${SERVICE}] spend verification key does not match the pinned circuit manifest`);
    process.exit(1);
  }
  const spendVk = JSON.parse(vkBytes.toString("utf8")) as VerificationKey;
  const poseidon = await getPoseidon();
  const sponsorCap = BigInt(process.env.RELAYER_SPONSOR_LAMPORT_CAP?.trim() || "100000000");
  // A relative path is from the repository root, not this service's working directory.
  const approvedLabelsPath = resolve(rootDir, process.env.APPROVED_LABELS_PATH?.trim() || join("artifacts", "deployment", "approved-labels.json"));

  let deployment: DeploymentStatus = { state: "missing", reason: "not checked yet" };
  let indexer: Indexer | null = null;
  const manifest = (): DeploymentManifest | null => (deployment.state === "verified" ? deployment.manifest : null);
  const ctx = { db, chain, sponsor, manifest, spendVk, sponsorCapLamports: sponsorCap };
  const withdrawals = new WithdrawalService(ctx);
  const recoveries = new RecoveryService(ctx);
  const swaps = new SwapService(ctx);
  const buildDir = process.env.VEILO_CIRCUIT_BUILD_DIR?.trim() || join(rootDir, "circuits", "build");
  const insertPaths = { wasmPath: join(buildDir, "insert", "insert_js", "insert.wasm"), zkeyPath: join(buildDir, "zkey", "insert_final.zkey") };
  const insertProver = existsSync(insertPaths.zkeyPath)
    ? { prove: (w: Parameters<typeof prove>[0]) => prove(w, { ...insertPaths, wasmSha256: pins.circuits.insert.wasmSha256, zkeySha256: pins.circuits.insert.zkeySha256 }) }
    : null;
  let crank: InsertCrank | null = null;

  const checkDeployment = async () => {
    deployment = await verifyDeployment({
      manifestPath: config.pool.deploymentManifestPath,
      repoRoot: rootDir,
      programId: config.pool.programId,
      poolId: config.pool.poolId,
      mint: config.network.mint,
      chain,
    });
    if (deployment.state === "mismatch") {
      console.error(`[${SERVICE}] deployment manifest mismatch; stopping: ${deployment.reason}`);
      process.exit(1);
    }
    if (deployment.state === "verified" && !indexer) {
      const m = deployment.manifest;
      indexer = new Indexer(db, chain, poseidon, address(m.program.programId), address(m.pool.poolState), address(m.pool.approvalState), approvedLabelsPath);
      crank = new InsertCrank({ db, chain, indexer, poseidon, sponsor, manifest, prover: insertProver, sponsorCapLamports: sponsorCap });
      console.log(`[${SERVICE}] deployment verified; indexer and insert crank enabled`);
    } else if (deployment.state === "missing") {
      console.log(`[${SERVICE}] ${deployment.reason}; withdrawals and public state stay unavailable`);
      setTimeout(() => void checkDeployment().catch(() => undefined), 60_000);
    }
  };
  await checkDeployment().catch((error: Error) => console.error(`[${SERVICE}] deployment check failed: ${error.name}`));

  const app = createApp(health, { db, deployment: () => deployment, indexer: () => indexer, withdrawals, recoveries, swaps, walletCredentialDigest });
  app.listen(config.ports.relayer, config.bindHost, () => {
    console.log(`[${SERVICE}] listening on http://${config.bindHost}:${config.ports.relayer} (${config.network.caip2})`);
  });
  if (process.env.VEILO_LOG_CONFIG === "1") console.log(JSON.stringify(describeConfig(config)));

  // Pending work resumes from persisted signatures after restart; nothing is re-signed blindly.
  const loop = async () => {
    if (manifest()) {
      for (const id of withdrawals.pendingIds()) await withdrawals.advance(id).catch(() => undefined);
      for (const id of recoveries.pendingIds()) await recoveries.advance(id).catch(() => undefined);
      for (const id of swaps.pendingIds()) await swaps.advance(id).catch(() => undefined);
      if (crank) await crank.step().catch((e: Error) => console.error(`[${SERVICE}] crank: ${e.name}: ${e.message}`));
    }
    setTimeout(() => void loop(), 5_000);
  };
  void loop();
}

main().catch((error: unknown) => {
  if (error instanceof VeiloConfigError) {
    console.error(`[${SERVICE}] configuration rejected (${error.code}): ${error.message}`);
    process.exit(1);
  }
  console.error(`[${SERVICE}] failed to start: ${(error as Error).name}: ${(error as Error).message}`);
  process.exit(1);
});
