// Builds a complete local test environment from nothing: throwaway role keys, a fresh loopback
// validator with the deployed program build, an initialized pool with its manifest, the merchant
// ATA, service credentials, an environment file for every service and the idempotent demo seed.
// All files live under one work directory; nothing reaches devnet.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { address } from "@solana/kit";
import { DEMO_TOKEN_MINT, DEVNET_CAIP2, DEVNET_GENESIS_HASH } from "@veilo/contracts";
import { approvalStatePda, associatedTokenAddress, buildApprovedTree, decodePoolState, getPoseidon, initializePoolInstruction, parseDeploymentManifest, poolStatePda, vaultAuthorityPda } from "../../packages/privacy-sdk/src/index";
import { createRpcRelayerChain } from "../../services/relayer/src/chain";
import { verifyDeployment } from "../../services/relayer/src/deployment";
import { ensureOwnerServiceSecret } from "../../services/wallet/src/secret";
import { airdrop, ensureAta } from "./chain";
import { ensureKeypairFile, ensureTokenFile } from "./keys";
import { PROGRAM_SO, startValidator, type LocalValidator } from "./validator";
import { ata, awaitTx, computeUnitLimitIx, getAccount, loadSigner, programDataAddress, REPO, sha256Hex, signAndSend, writeJson } from "../devnet/lib";
import { deploymentManifest, GENESIS_HEX } from "../devnet/manifest";
import { currentProgramIds } from "../devnet/set-program-id";

/** The id compiled into the program binary; the validator preloads the binary at this address. */
export const PROGRAM_ID = (() => {
  const id = currentProgramIds().declareId;
  if (!id) throw new Error("programs/privacy-pool/src/lib.rs has no declare_id!");
  return id;
})();
export const LOCAL_ROLES = ["deployer", "sponsor", "merchant", "approvalAuthority", "configAuthority", "mintAuthority", "facilitatorFeePayer", "owner", "participantB"] as const;
export type LocalRole = (typeof LOCAL_ROLES)[number];

export interface PortPlan {
  dashboard: number;
  control: number;
  runner: number;
  wallet: number;
  gateway: number;
  relayer: number;
  proxies: Record<Link, number>;
  facilitator: number;
  provider: number;
  rpc: number;
}

export const LINKS = ["control→wallet", "control→gateway", "wallet→control", "wallet→relayer", "runner→control", "gateway→facilitator", "relayer→rpc", "wallet→rpc", "gateway→rpc"] as const;
export type Link = (typeof LINKS)[number];

export function portPlan(base: number): PortPlan {
  const proxies = Object.fromEntries(LINKS.map((l, i) => [l, base + 11 + i])) as Record<Link, number>;
  return { dashboard: base, control: base + 1, runner: base + 2, wallet: base + 3, gateway: base + 4, relayer: base + 5, proxies, facilitator: base + 25, provider: base + 26, rpc: base + 30 };
}

export interface Bootstrapped {
  dir: string;
  envFile: string;
  env: Record<string, string>;
  keys: Record<LocalRole, { path: string; publicKey: string }>;
  validator: LocalValidator;
  manifest: ReturnType<typeof parseDeploymentManifest>;
  poolId: string;
}

const p = (dir: string, ...parts: string[]) => join(dir, ...parts);
const relRepo = (x: string) => relative(REPO, x).split("\\").join("/");

export async function bootstrapLocal(o: { name: string; dir: string; ports: PortPlan; extraEnv?: Record<string, string>; reuse?: boolean; log?: (m: string) => void }): Promise<Bootstrapped> {
  const log = o.log ?? ((m: string) => console.log(`  ${m}`));
  mkdirSync(o.dir, { recursive: true });
  const keys = {} as Bootstrapped["keys"];
  for (const role of LOCAL_ROLES) {
    const path = p(o.dir, "keys", `${role}.json`);
    keys[role] = { path, publicKey: ensureKeypairFile(path) };
  }
  log(`validator: starting ${o.name} (fresh ledger, program ${PROGRAM_ID} preloaded from ${PROGRAM_SO})`);
  const validator = await startValidator({ name: o.name, rpcPort: o.ports.rpc, workDir: o.dir, programId: PROGRAM_ID, upgradeAuthority: keys.deployer.publicKey, mintAuthority: keys.mintAuthority.publicKey, reuse: o.reuse ?? false });
  const rpc = validator.rpc;
  const sol = 1_000_000_000n;
  for (const [role, amount] of [["deployer", 10n * sol], ["sponsor", 20n * sol], ["approvalAuthority", sol], ["owner", 20n * sol], ["participantB", 2n * sol], ["facilitatorFeePayer", 10n * sol], ["mintAuthority", sol]] as const) {
    await airdrop(rpc, validator.rpcUrl, keys[role].publicKey, amount);
  }

  const poolIdPath = p(o.dir, "pool-id.txt");
  if (!existsSync(poolIdPath)) writeFileSync(poolIdPath, randomBytes(32).toString("hex"));
  const poolId = readFileSync(poolIdPath, "utf8").trim();
  const programId = address(PROGRAM_ID);
  const mint = address(DEMO_TOKEN_MINT);
  const poolState = (await poolStatePda(programId, Buffer.from(poolId, "hex"))).address;
  const vaultAuthority = (await vaultAuthorityPda(programId, poolState)).address;
  const vault = (await associatedTokenAddress(vaultAuthority, mint)).address;
  const approvalState = (await approvalStatePda(programId, poolState)).address;
  const programData = await programDataAddress(programId);
  const deployer = await loadSigner(keys.deployer.path);
  const sigs: { initializePool?: string; merchantAta?: string } = {};
  if (!(await getAccount(rpc, poolState))) {
    const sent = await signAndSend(rpc, deployer, [], [
      computeUnitLimitIx(200_000),
      initializePoolInstruction(programId, { deployer: deployer.address, programData, poolState, vaultAuthority, mint, vault, approvalState }, {
        poolId: Buffer.from(poolId, "hex"),
        genesisHash: Buffer.from(GENESIS_HEX, "hex"),
        expectedDecimals: 6,
        approvalAuthority: address(keys.approvalAuthority.publicKey),
        configAuthority: address(keys.configAuthority.publicKey),
      }),
    ], () => undefined);
    const r = await awaitTx(rpc, sent, 120_000);
    if (r.state !== "finalized" || r.outcome.err !== null) throw new Error(`initialize_pool did not finalize: ${r.state}`);
    sigs.initializePool = sent.signature;
    log(`pool: initialized ${poolState} (${sent.signature})`);
  }
  const merchantAta = await ensureAta(rpc, deployer, keys.merchant.publicKey);
  await ensureAta(rpc, deployer, keys.owner.publicKey);
  const ps = decodePoolState((await getAccount(rpc, poolState))!.data);
  const poseidon = await getPoseidon();
  const binary = new Uint8Array(readFileSync(p(REPO, PROGRAM_SO)));
  const manifestPath = p(o.dir, "deployment.json");
  if (!existsSync(manifestPath)) {
    const manifest = deploymentManifest({
      rootDir: REPO,
      caip2: DEVNET_CAIP2,
      genesisHash: DEVNET_GENESIS_HASH,
      programId,
      programData,
      binary,
      poolId,
      poolState,
      vaultAuthority,
      vault,
      approvalState,
      mint,
      freezeAuthority: null,
      pool: { emptyRoot: buildApprovedTree(poseidon, []).root.toString(), minDeposit: ps.minDeposit.toString(), maxDeposit: ps.maxDeposit.toString(), liabilityCap: ps.liabilityCap.toString(), maxRelayerFee: ps.maxRelayerFee.toString() },
      authorities: { deployer: keys.deployer.publicKey, configAuthority: keys.configAuthority.publicKey, approvalAuthority: keys.approvalAuthority.publicKey, sponsor: keys.sponsor.publicKey },
      signatures: { initializePool: sigs.initializePool ?? null, merchantAta: sigs.merchantAta ?? null },
      gateway: { merchantAddress: keys.merchant.publicKey, merchantAta, facilitatorFeePayer: keys.facilitatorFeePayer.publicKey },
      createdAt: new Date().toISOString(),
    });
    writeJson(manifestPath, { ...manifest, localTestValidator: { note: "LOCAL TEST VALIDATOR deployment (not devnet); program binary sha256 " + sha256Hex(binary), genesisHash: validator.genesisHash } });
  }
  const labelsPath = p(o.dir, "approved-labels.json");
  if (!existsSync(labelsPath)) {
    writeJson(labelsPath, { schema: "veilo-approved-labels-v1", pool: poolState, rule: "local test: labels of inserted deposits by the configured test participants", labels: [], root: buildApprovedTree(poseidon, []).root.toString() });
  }
  const check = await verifyDeployment({ manifestPath, repoRoot: REPO, programId, poolId, mint, chain: createRpcRelayerChain(validator.rpcUrl) });
  if (check.state !== "verified") throw new Error(`local deployment manifest not verified: ${check.reason}`);

  const secrets = p(o.dir, "secrets");
  const data = p(o.dir, "data");
  mkdirSync(data, { recursive: true });
  ensureOwnerServiceSecret(p(secrets, "owner-service.secret"));
  ensureTokenFile(p(secrets, "control-service.credential"), "vcs");
  ensureTokenFile(p(secrets, "wallet-service.credential"), "vws");
  const ports = o.ports;
  const env: Record<string, string> = {
    VEILO_CHAIN_PROFILE: "local-test-validator",
    DEVNET_RPC_URL: validator.rpcUrl,
    EXPECTED_DEVNET_GENESIS_HASH: DEVNET_GENESIS_HASH,
    DEMO_TOKEN_MINT,
    FACILITATOR_URL: `http://127.0.0.1:${ports.facilitator}`,
    POOL_PROGRAM_ID: PROGRAM_ID,
    POOL_ID: poolId,
    DEPLOYMENT_MANIFEST_PATH: relRepo(manifestPath),
    PLANNER_MODEL_ID: "mistralai/mistral-nemo",
    INFERENCE_MODEL_ID: "mistralai/mistral-nemo",
    OPERATOR_MAX_REAL_USD_MICRO: "1000000",
    GATEWAY_TEST_PROVIDER_URL: `http://127.0.0.1:${ports.provider}`,
    SPONSOR_KEY_PATH: relRepo(keys.sponsor.path),
    OWNER_SERVICE_SECRET_PATH: relRepo(p(secrets, "owner-service.secret")),
    CONTROL_DATABASE_PATH: relRepo(p(data, "control.sqlite")),
    GATEWAY_DATABASE_PATH: relRepo(p(data, "gateway.sqlite")),
    RELAYER_DATABASE_PATH: relRepo(p(data, "relayer.sqlite")),
    VEILO_DATA_DIR: relRepo(data),
    VEILO_SECRETS_DIR: relRepo(secrets),
    VEILO_BIND_HOST: "127.0.0.1",
    DASHBOARD_PORT: String(ports.dashboard),
    CONTROL_PORT: String(ports.control),
    RUNNER_PORT: String(ports.runner),
    WALLET_PORT: String(ports.wallet),
    GATEWAY_PORT: String(ports.gateway),
    RELAYER_PORT: String(ports.relayer),
    CONTROL_SERVICE_CREDENTIAL_PATH: relRepo(p(secrets, "control-service.credential")),
    WALLET_SERVICE_CREDENTIAL_PATH: relRepo(p(secrets, "wallet-service.credential")),
    RUNNER_WORKER_CREDENTIAL_PATH: relRepo(p(secrets, "runner", "worker-credentials.json")),
    GATEWAY_IDENTITY: "veilo-gateway-devnet",
    GATEWAY_PUBLIC_ORIGIN: `http://127.0.0.1:${ports.proxies["control→gateway"]}`,
    GATEWAY_MERCHANT_ADDRESS: keys.merchant.publicKey,
    GATEWAY_FACILITATOR_FEE_PAYER: keys.facilitatorFeePayer.publicKey,
    GATEWAY_SETTLEMENT_WAIT_MS: "40000",
    USAGE_PERMIT_PUBLIC_KEY_PATH: relRepo(p(secrets, "gateway", "usage-permit-public.pem")),
    GATEWAY_PLANNING_CREDENTIAL_PATH: relRepo(p(secrets, "gateway", "planning.token")),
    VEILO_OWNER_PUBKEY: keys.owner.publicKey,
    CONTROL_USAGE_PERMIT_KEY_PATH: relRepo(p(secrets, "control", "usage-permit-signing.pem")),
    CONTROL_GATEWAY_ACCOUNT_TOKEN_PATH: relRepo(p(secrets, "control", "gateway-account.token")),
    OWNER_RECOVERY_ADDRESS: keys.owner.publicKey,
    RELAYER_SPONSOR_LAMPORT_CAP: "5000000000",
    APPROVED_LABELS_PATH: relRepo(labelsPath),
    APPROVED_PARTICIPANTS: `${keys.owner.publicKey},${keys.participantB.publicKey}`,
    VEILO_DASHBOARD_ORIGIN: `http://localhost:${ports.dashboard}`,
    ...(o.extraEnv ?? {}),
  };
  const envFile = p(o.dir, "stack.env");
  writeFileSync(envFile, `# Generated local test validator stack (${o.name}); not devnet.\n${Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n")}\n`);
  const seed = spawnSync(process.execPath, ["--import", "tsx", "scripts/demo-seed.ts"], { cwd: REPO, env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", USERNAME: process.env.USERNAME ?? "", USERDOMAIN: process.env.USERDOMAIN ?? "", TEMP: process.env.TEMP ?? "", VEILO_ENV_FILE: envFile }, encoding: "utf8" });
  if (seed.status !== 0) throw new Error(`demo:seed failed: ${(seed.stderr || seed.stdout).slice(-800)}`);
  log("demo:seed: workspace, agents (draft policies), shared gateway account and integration secrets ready");
  return { dir: o.dir, envFile, env, keys, validator, manifest: parseDeploymentManifest(JSON.parse(readFileSync(manifestPath, "utf8"))), poolId };
}

export { ata };
