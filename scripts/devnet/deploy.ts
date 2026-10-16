// Budgeted, resumable devnet deployment of the privacy pool. Dry run by default (read-only RPC);
// signs only with --execute --confirm. Every signature is persisted before it is sent and every
// step is verified against finalized chain state, so a rerun resumes instead of repeating.
//
//   pnpm deploy:devnet                                       plan + checks, nothing signed
//   pnpm deploy:devnet -- --funding <keypair> --execute --confirm
//   pnpm deploy:devnet -- --fund-test-usdc [--usdc-per-participant 200000] [--funding <keypair>] [--execute --confirm]
//
// Steps: fund-roles → deploy-program → initialize-pool → merchant-ata → approval-root → manifest.
// A rerun never creates a second pool, never replaces keys and never overwrites a manifest that
// disagrees with the chain; any mismatch stops the run.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join, relative } from "node:path";
import { address, getAddressEncoder, type Address, type KeyPairSigner } from "@solana/kit";
import { findRepoRoot, loadConfig, loadDotEnv, redactUrl } from "@veilo/contracts";
import { checkFacilitatorSupport, fetchFacilitatorSupported } from "@veilo/x402-client";
import {
  approvalStatePda,
  assertManifestMatches,
  associatedTokenAddress,
  buildApprovedTree,
  decodeApprovalState,
  decodePoolState,
  getPoseidon,
  initializePoolInstruction,
  parseDeploymentManifest,
  poolStatePda,
  vaultAuthorityPda,
} from "../../packages/privacy-sdk/src/index";
import { verifyDeployment } from "../../services/relayer/src/deployment";
import { createRpcRelayerChain } from "../../services/relayer/src/chain";
import { TOOLCHAIN_IMAGE } from "../toolchain-image.mjs";
import { fillEnv } from "./env-file";
import {
  argValue,
  ata,
  awaitTx,
  checkRoleFiles,
  computeUnitLimitIx,
  createAtaIdempotentIx,
  decodeMint,
  decodeProgramAccount,
  decodeProgramData,
  decodeTokenAccount,
  acquireRunLock,
  DEPLOY_PROGRESS_PATH,
  EVIDENCE_DIR,
  PROFILE,
  verifyNetwork,
  executeMode,
  explorerAddress,
  explorerTx,
  getAccount,
  hasFlag,
  lamportsOf,
  LAMPORTS_PER_SIGNATURE,
  loadSigner,
  makeRpc,
  programDataAddress,
  publicKeyOfKeyFile,
  readJsonOr,
  readRoles,
  rentFor,
  repoPath,
  roleSigner,
  sha256Hex,
  signAndSend,
  sol,
  systemTransferIx,
  TOKEN_PROGRAM,
  transferCheckedIx,
  usdc,
  writeJson,
  type Rpc,
  type RolesFile,
  type SentTx,
  type TxOutcome,
} from "./lib";
import { currentProgramIds } from "./set-program-id";

const GENESIS_HEX = "ce59db5080fc2c6d3bcf7ca90712d3c2e5e6c28f27f0dfbb9953bdb0894c03ab";
const SCALAR_FIELD = "21888242871839275222246405745257275088548364400416034343698204186575808495617";
const ROOT_HISTORY_RULE = "spend/exit accept any of the newest 32 commitment roots; insert accepts only the current root; spend accepts only the current approved root";
/** Bytes per loader-v3 Write transaction used for the fee estimate (the CLI packs slightly more). */
const WRITE_CHUNK = 1_000;
const FEE_RETRY_FACTOR = 2n;
const MARGIN_DEPLOYER = 20_000_000n;
/** Role SOL targets beyond deployment. Sponsor: ATA rent + spend rent + fees for dozens of private purchases. */
const ROLE_TARGETS: Partial<Record<keyof RolesFile["roles"], bigint>> = {
  sponsor: 300_000_000n,
  approvalAuthority: 10_000_000n,
  testOwnerA: 30_000_000n,
  testOwnerB: 30_000_000n,
};
const PARTICIPANTS = ["testOwnerA", "testOwnerB"] as const;

const STEP_NAMES = ["fund-roles", "deploy-program", "initialize-pool", "merchant-ata", "approval-root", "manifest", "fund-test-usdc"] as const;
type StepName = (typeof STEP_NAMES)[number];

interface StepRecord {
  state: "sent" | "done";
  sent?: SentTx;
  outcome?: TxOutcome;
  details?: Record<string, unknown>;
  at: string;
}

interface Progress {
  schema: "veilo-devnet-deploy-progress-v1";
  programId: string;
  poolId: string;
  steps: Partial<Record<StepName, StepRecord>>;
  attempts: Array<{ step: StepName; sent: SentTx; result: string }>;
}

const rootDir = findRepoRoot();
loadDotEnv({ rootDir });
const config = loadConfig(process.env, { rootDir });
const rpc: Rpc = makeRpc(config.network.rpcUrl);
const execute = executeMode();
const mint = address(config.network.mint);

class Stop extends Error {
  override readonly name = "Stop";
}
function stop(msg: string): never {
  throw new Stop(msg);
}

function loadProgress(roles: RolesFile): Progress {
  const p = readJsonOr<Progress | null>(DEPLOY_PROGRESS_PATH, null);
  if (p === null) return { schema: "veilo-devnet-deploy-progress-v1", programId: roles.roles.programId.publicKey, poolId: roles.poolId, steps: {}, attempts: [] };
  if (p.programId !== roles.roles.programId.publicKey || p.poolId !== roles.poolId) {
    stop("devnet.progress.json belongs to a different program id or pool id than roles.devnet.json; refusing to mix deployments");
  }
  return p;
}

const saveProgress = (p: Progress) => writeJson(DEPLOY_PROGRESS_PATH, p);
const now = () => new Date().toISOString();

/**
 * Runs one transaction step with reconciliation: a previously sent attempt is awaited first;
 * only an attempt whose blockhash expired unseen is rebuilt.
 */
async function txStep(p: Progress, step: StepName, feePayer: KeyPairSigner, extra: KeyPairSigner[], build: () => Promise<Parameters<typeof signAndSend>[3]>, details: Record<string, unknown>): Promise<TxOutcome> {
  const rec = p.steps[step];
  if (rec?.state === "sent" && rec.sent) {
    console.log(`  ${step}: reconciling earlier attempt ${rec.sent.signature}`);
    const r = await awaitTx(rpc, rec.sent);
    if (r.state === "pending") stop(`${step}: earlier transaction ${rec.sent.signature} is not finalized yet; rerun later (nothing new was signed)`);
    if (r.state === "finalized") {
      p.attempts.push({ step, sent: rec.sent, result: r.outcome.err === null ? "finalized" : "failed" });
      if (r.outcome.err !== null) stop(`${step}: transaction ${rec.sent.signature} failed on chain: ${JSON.stringify(r.outcome.err)}`);
      p.steps[step] = { state: "done", sent: rec.sent, outcome: r.outcome, details: rec.details ?? details, at: now() };
      saveProgress(p);
      return r.outcome;
    }
    p.attempts.push({ step, sent: rec.sent, result: "expired unseen" });
    saveProgress(p);
  }
  const ixs = await build();
  const sent = await signAndSend(rpc, feePayer, extra, ixs, (s) => {
    p.steps[step] = { state: "sent", sent: s, details, at: now() };
    saveProgress(p);
  }).catch((error: unknown) => stop(`${step}: send failed (${(error as Error).message}); the signature was recorded and will be reconciled on rerun`));
  console.log(`  ${step}: sent ${sent.signature}`);
  const r = await awaitTx(rpc, sent);
  if (r.state !== "finalized") stop(`${step}: transaction ${sent.signature} ${r.state === "expired" ? "expired before landing" : "not finalized within the wait"}; rerun to reconcile`);
  if (r.outcome.err !== null) {
    p.attempts.push({ step, sent, result: "failed" });
    saveProgress(p);
    stop(`${step}: transaction failed on chain: ${JSON.stringify(r.outcome.err)}`);
  }
  p.steps[step] = { state: "done", sent, outcome: r.outcome, details, at: now() };
  p.attempts.push({ step, sent, result: "finalized" });
  saveProgress(p);
  console.log(`  ${step}: finalized in slot ${r.outcome.slot} (${explorerTx(sent.signature)})`);
  return r.outcome;
}

// ---------------------------------------------------------------------------------------

interface Addresses {
  programId: Address;
  programData: Address;
  poolState: Address;
  vaultAuthority: Address;
  vault: Address;
  approvalState: Address;
  merchantAta: Address;
}

async function addresses(roles: RolesFile): Promise<Addresses> {
  const programId = address(roles.roles.programId.publicKey);
  const poolState = (await poolStatePda(programId, Buffer.from(roles.poolId, "hex"))).address;
  const vaultAuthority = (await vaultAuthorityPda(programId, poolState)).address;
  return {
    programId,
    programData: await programDataAddress(programId),
    poolState,
    vaultAuthority,
    vault: (await associatedTokenAddress(vaultAuthority, mint)).address,
    approvalState: (await approvalStatePda(programId, poolState)).address,
    merchantAta: await ata(roles.roles.merchant.publicKey, mint),
  };
}

interface ChainState {
  programDeployed: boolean;
  programDataMatches: boolean | null;
  upgradeAuthority: string | null;
  poolInitialized: boolean;
  merchantAtaExists: boolean;
  bufferLamports: bigint;
}

async function chainState(roles: RolesFile, a: Addresses, binary: Uint8Array): Promise<ChainState> {
  const prog = await getAccount(rpc, a.programId);
  let programDataMatches: boolean | null = null;
  let upgradeAuthority: string | null = null;
  if (prog) {
    if (!prog.executable || prog.owner !== "BPFLoaderUpgradeab1e11111111111111111111111") stop(`program id ${a.programId} exists but is not an upgradeable program`);
    if (decodeProgramAccount(prog.data).programData !== a.programData) stop("program account points at an unexpected ProgramData address");
    const pd = await getAccount(rpc, a.programData);
    if (!pd) stop("ProgramData account missing");
    const d = decodeProgramData(pd!.data);
    upgradeAuthority = d.upgradeAuthority;
    const elf = d.elf;
    programDataMatches = elf.length >= binary.length && sha256Hex(elf.subarray(0, binary.length)) === sha256Hex(binary) && elf.subarray(binary.length).every((b) => b === 0);
  }
  const buffer = await getAccount(rpc, roles.roles.programBuffer.publicKey);
  return {
    programDeployed: prog !== null,
    programDataMatches,
    upgradeAuthority,
    poolInitialized: (await getAccount(rpc, a.poolState)) !== null,
    merchantAtaExists: (await getAccount(rpc, a.merchantAta)) !== null,
    bufferLamports: buffer?.lamports ?? 0n,
  };
}

interface Plan {
  binaryBytes: number;
  maxLen: number;
  rent: Record<string, bigint>;
  fees: Record<string, bigint>;
  topUps: Array<{ role: string; address: string; current: bigint; target: bigint; amount: bigint }>;
  fundingNeeded: bigint;
  peakDeployer: bigint;
  lockedAfter: bigint;
}

async function plan(roles: RolesFile, binary: Uint8Array, cs: ChainState): Promise<Plan> {
  const len = binary.length;
  const rent = {
    programData: await rentFor(rpc, 45 + len),
    program: await rentFor(rpc, 36),
    buffer: await rentFor(rpc, 37 + len),
    poolState: await rentFor(rpc, 1407),
    approvalState: await rentFor(rpc, 121),
    vault: await rentFor(rpc, 165),
    merchantAta: await rentFor(rpc, 165),
  };
  const writeTxs = BigInt(Math.ceil(len / WRITE_CHUNK));
  const fees = {
    deploy: (writeTxs + 6n) * LAMPORTS_PER_SIGNATURE * FEE_RETRY_FACTOR,
    initializePool: LAMPORTS_PER_SIGNATURE * FEE_RETRY_FACTOR,
    merchantAta: LAMPORTS_PER_SIGNATURE * FEE_RETRY_FACTOR,
    fundRoles: LAMPORTS_PER_SIGNATURE * FEE_RETRY_FACTOR,
  };
  let deployerNeed = MARGIN_DEPLOYER;
  if (!cs.programDeployed) deployerNeed += rent.programData + rent.program + rent.buffer - cs.bufferLamports + fees.deploy;
  if (!cs.poolInitialized) deployerNeed += rent.poolState + rent.approvalState + rent.vault + fees.initializePool;
  if (!cs.merchantAtaExists) deployerNeed += rent.merchantAta + fees.merchantAta;
  const targets: Array<[string, bigint]> = [["deployer", deployerNeed], ...Object.entries(ROLE_TARGETS).map(([k, v]) => [k, v] as [string, bigint])];
  const topUps: Plan["topUps"] = [];
  for (const [role, target] of targets) {
    const addr = roles.roles[role as keyof RolesFile["roles"]].publicKey;
    const current = await lamportsOf(rpc, addr);
    topUps.push({ role, address: addr, current, target, amount: current >= target ? 0n : target - current });
  }
  const fundingNeeded = topUps.reduce((s, t) => s + t.amount, 0n) + fees.fundRoles;
  return {
    binaryBytes: len,
    maxLen: len,
    rent,
    fees,
    topUps,
    fundingNeeded,
    peakDeployer: rent.programData + rent.program + rent.buffer + fees.deploy,
    lockedAfter: rent.programData + rent.program + rent.poolState + rent.approvalState + rent.vault + rent.merchantAta,
  };
}

// ---------------------------------------------------------------------------------------

function binaryPath(): string {
  return repoPath(argValue("--binary") ?? "target/deploy/privacy_pool.so");
}

function preflightLocal(roles: RolesFile): { binary: Uint8Array; problems: string[] } {
  const problems = checkRoleFiles(roles);
  const ids = currentProgramIds();
  const pid = roles.roles.programId.publicKey;
  if (ids.declareId !== pid || ids.anchorToml !== pid || ids.idl !== pid) problems.push(`program id not applied (declare_id ${ids.declareId}, Anchor.toml ${ids.anchorToml}, IDL ${ids.idl}); run pnpm program:set-id and rebuild`);
  if (roles.roles.sponsor.publicKey === roles.roles.deployer.publicKey) problems.push("sponsor must be separate from the deployer");
  const bp = binaryPath();
  if (!existsSync(bp)) {
    problems.push(`program binary ${relative(rootDir, bp)} missing; run pnpm tc -- anchor build --ignore-keys`);
    return { binary: new Uint8Array(), problems };
  }
  const binary = new Uint8Array(readFileSync(bp));
  if (!Buffer.from(binary).includes(Buffer.from(getAddressEncoder().encode(address(pid))))) problems.push("program binary does not embed the role program id; rebuild after pnpm program:set-id");
  for (const f of ["artifacts/circuits/manifest.json", "artifacts/vectors/v1.json", "artifacts/program/privacy_pool.json"]) if (!existsSync(join(rootDir, f))) problems.push(`${f} missing`);
  return { binary, problems };
}

async function fundingSigner(): Promise<KeyPairSigner | null> {
  const path = argValue("--funding") ?? process.env.FUNDING_KEY_PATH?.trim();
  if (!path) return null;
  return loadSigner(repoPath(path));
}

function fundingAddress(): string | null {
  const path = argValue("--funding") ?? process.env.FUNDING_KEY_PATH?.trim();
  return path ? publicKeyOfKeyFile(repoPath(path)) : null;
}

// ---------------------------------------------------------------------------------------
// Steps

async function stepFundRoles(p: Progress, pl: Plan, funding: KeyPairSigner): Promise<void> {
  const done = p.steps["fund-roles"];
  const need = pl.topUps.filter((t) => t.amount > 0n);
  if (done?.state === "done" && !hasFlag("--top-up")) {
    if (need.length > 0) console.log(`  fund-roles: done earlier (${done.sent?.signature}); ${need.length} role(s) are below target now — pass --top-up to fund the difference explicitly`);
    else console.log("  fund-roles: done");
    return;
  }
  if (need.length === 0 && done?.state !== "sent") {
    console.log("  fund-roles: every role already at or above its target");
    p.steps["fund-roles"] = { state: "done", details: { note: "no transfer needed" }, at: now() };
    saveProgress(p);
    return;
  }
  await txStep(
    p,
    "fund-roles",
    funding,
    [],
    async () => need.map((t) => systemTransferIx(funding.address, address(t.address), t.amount)),
    { transfers: need.map((t) => ({ role: t.role, to: t.address, lamports: t.amount.toString() })) },
  );
}

function dockerSolana(args: string[]): { status: number; stdout: string } {
  const r = spawnSync(
    "docker",
    ["run", "--rm", "-v", `${rootDir}:/workspace`, "-w", "/workspace", TOOLCHAIN_IMAGE, "solana", ...args],
    { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.error) stop(`docker failed to start: ${r.error.message}`);
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
}

async function stepDeploy(p: Progress, roles: RolesFile, a: Addresses, binary: Uint8Array, cs: ChainState): Promise<void> {
  if (cs.programDeployed) {
    if (!cs.programDataMatches) stop("program is deployed but its ProgramData differs from the local binary; upgrades are not automated — investigate before continuing");
    if (cs.upgradeAuthority !== roles.roles.deployer.publicKey) stop(`program upgrade authority is ${cs.upgradeAuthority}, expected the deployer`);
    if (p.steps["deploy-program"]?.state !== "done") {
      const sigs = await rpc.getSignaturesForAddress(a.programId, { commitment: "finalized", limit: 1000 }).send();
      const first = sigs[sigs.length - 1]?.signature ?? null;
      p.steps["deploy-program"] = { state: "done", details: { recoveredFromChain: true, deploySignature: first }, at: now() };
      saveProgress(p);
    }
    console.log("  deploy-program: deployed and verified (ProgramData bytes equal the local binary, upgrade authority = deployer)");
    return;
  }
  const rel = (k: keyof RolesFile["roles"]) => roles.roles[k].keyPath;
  const args = [
    "program",
    "deploy",
    relative(rootDir, binaryPath()).split("\\").join("/"),
    "--url",
    config.network.rpcUrl,
    "--keypair",
    rel("deployer"),
    "--program-id",
    rel("programId"),
    "--buffer",
    rel("programBuffer"),
    "--upgrade-authority",
    rel("deployer"),
    "--max-len",
    String(binary.length),
    "--max-sign-attempts",
    "50",
    "--commitment",
    "finalized",
    "--output",
    "json",
  ];
  p.steps["deploy-program"] = { state: "sent", details: { command: "solana program deploy (toolchain image)", maxLen: binary.length, buffer: roles.roles.programBuffer.publicKey }, at: now() };
  saveProgress(p);
  console.log(`  deploy-program: running solana program deploy in ${TOOLCHAIN_IMAGE} (RPC ${redactUrl(config.network.rpcUrl)}); buffer ${roles.roles.programBuffer.publicKey} makes an interrupted deploy resumable`);
  const r = dockerSolana(args);
  const json = /\{[\s\S]*\}\s*$/.exec(r.stdout)?.[0];
  if (r.status !== 0 || !json) stop(`solana program deploy exited ${r.status}; rerun the same command to resume from the buffer (or reclaim it with: pnpm tc -- solana program close ${roles.roles.programBuffer.publicKey} --url <rpc> --keypair ${rel("deployer")})`);
  const out = JSON.parse(json!) as { programId?: string; signature?: string };
  if (out.programId !== a.programId) stop(`CLI reported program id ${out.programId}, expected ${a.programId}`);
  const after = await chainState(roles, a, binary);
  if (!after.programDeployed || !after.programDataMatches || after.upgradeAuthority !== roles.roles.deployer.publicKey) stop("post-deploy verification failed (program/ProgramData/upgrade authority)");
  const outcome = out.signature ? await finalizedOutcome(out.signature) : null;
  p.steps["deploy-program"] = { state: "done", ...(outcome ? { outcome } : {}), details: { deploySignature: out.signature ?? null, maxLen: binary.length }, at: now() };
  saveProgress(p);
  console.log(`  deploy-program: verified; signature ${out.signature ?? "(not reported)"}`);
}

async function finalizedOutcome(sig: string): Promise<TxOutcome | null> {
  const r = await awaitTx(rpc, { signature: sig, lastValidBlockHeight: "0", sentAt: now() }, 60_000);
  return r.state === "finalized" ? r.outcome : null;
}

async function verifyPool(roles: RolesFile, a: Addresses): Promise<Record<string, string>> {
  const p = await getPoseidon();
  const emptyRoot = buildApprovedTree(p, []).root;
  const ps = await getAccount(rpc, a.poolState);
  const ap = await getAccount(rpc, a.approvalState);
  const vault = await getAccount(rpc, a.vault);
  if (!ps || !ap || !vault) stop("pool accounts missing after initialization");
  if (ps!.owner !== a.programId || ap!.owner !== a.programId) stop("PoolState/ApprovalState not owned by the program");
  const pool = decodePoolState(ps!.data);
  const appr = decodeApprovalState(ap!.data);
  const v = decodeTokenAccount(vault!.data);
  const errs: string[] = [];
  if (pool.protocolVersion !== 1) errs.push("protocol version");
  if (Buffer.from(pool.poolId).toString("hex") !== roles.poolId) errs.push("pool id");
  if (pool.mint !== mint) errs.push("mint");
  if (pool.tokenProgram !== TOKEN_PROGRAM) errs.push("token program");
  if (pool.vault !== a.vault) errs.push("vault");
  if (Buffer.from(pool.genesisHash).toString("hex") !== GENESIS_HEX) errs.push("genesis");
  if (pool.configAuthority !== roles.roles.configAuthority.publicKey) errs.push("config authority");
  if (pool.mintDecimals !== 6) errs.push("decimals");
  if (appr.pool !== a.poolState || appr.approvalAuthority !== roles.roles.approvalAuthority.publicKey) errs.push("approval state binding");
  if (vault!.owner !== TOKEN_PROGRAM || v.mint !== mint || v.owner !== a.vaultAuthority || v.hasDelegate || v.hasCloseAuthority || v.state !== 1) errs.push("vault token account (owner/mint/authority/delegate/close authority)");
  if (errs.length > 0) stop(`on-chain pool state mismatch: ${errs.join(", ")}`);
  return {
    emptyRoot: emptyRoot.toString(),
    currentRoot: pool.currentRoot.toString(),
    approvedRoot: appr.approvedRoot.toString(),
    approvedVersion: appr.version.toString(),
    minDeposit: pool.minDeposit.toString(),
    maxDeposit: pool.maxDeposit.toString(),
    liabilityCap: pool.liabilityCap.toString(),
    maxRelayerFee: pool.maxRelayerFee.toString(),
    nextLeafIndex: pool.nextLeafIndex.toString(),
  };
}

async function stepInitialize(p: Progress, roles: RolesFile, a: Addresses, deployer: KeyPairSigner, cs: ChainState): Promise<void> {
  if (cs.poolInitialized && p.steps["initialize-pool"]?.state !== "sent") {
    const st = await verifyPool(roles, a);
    if (p.steps["initialize-pool"]?.state !== "done") {
      p.steps["initialize-pool"] = { state: "done", details: { recoveredFromChain: true, ...st }, at: now() };
      saveProgress(p);
    }
    console.log("  initialize-pool: PoolState exists and matches (no second pool is created)");
    return;
  }
  await txStep(
    p,
    "initialize-pool",
    deployer,
    [],
    async () => [
      computeUnitLimitIx(200_000),
      initializePoolInstruction(
        a.programId,
        { deployer: deployer.address, programData: a.programData, poolState: a.poolState, vaultAuthority: a.vaultAuthority, mint, vault: a.vault, approvalState: a.approvalState },
        {
          poolId: Buffer.from(roles.poolId, "hex"),
          genesisHash: Buffer.from(GENESIS_HEX, "hex"),
          expectedDecimals: 6,
          approvalAuthority: address(roles.roles.approvalAuthority.publicKey),
          configAuthority: address(roles.roles.configAuthority.publicKey),
        },
      ),
    ],
    { poolState: a.poolState, vault: a.vault, approvalState: a.approvalState },
  );
  const st = await verifyPool(roles, a);
  p.steps["initialize-pool"]!.details = { ...p.steps["initialize-pool"]!.details, ...st };
  saveProgress(p);
}

async function stepMerchantAta(p: Progress, roles: RolesFile, a: Addresses, deployer: KeyPairSigner, cs: ChainState): Promise<void> {
  const verify = async () => {
    const acct = await getAccount(rpc, a.merchantAta);
    if (!acct) stop("merchant ATA missing");
    const t = decodeTokenAccount(acct!.data);
    if (acct!.owner !== TOKEN_PROGRAM || t.mint !== mint || t.owner !== roles.roles.merchant.publicKey) stop("merchant ATA has the wrong owner or mint");
  };
  if (cs.merchantAtaExists && p.steps["merchant-ata"]?.state !== "sent") {
    await verify();
    if (p.steps["merchant-ata"]?.state !== "done") {
      p.steps["merchant-ata"] = { state: "done", details: { recoveredFromChain: true, merchantAta: a.merchantAta }, at: now() };
      saveProgress(p);
    }
    console.log("  merchant-ata: exists and verified");
    return;
  }
  await txStep(p, "merchant-ata", deployer, [], async () => [createAtaIdempotentIx(deployer.address, a.merchantAta, address(roles.roles.merchant.publicKey), mint)], {
    merchant: roles.roles.merchant.publicKey,
    merchantAta: a.merchantAta,
  });
  await verify();
}

async function stepApprovalRoot(p: Progress, roles: RolesFile, a: Addresses): Promise<void> {
  const st = await verifyPool(roles, a);
  const labelsPath = repoPath(process.env.APPROVED_LABELS_PATH?.trim() || "artifacts/deployment/approved-labels.json");
  const existing = readJsonOr<{ pool?: string; root?: string } | null>(labelsPath, null);
  if (existing && existing.pool !== a.poolState) stop(`${relative(rootDir, labelsPath)} belongs to another pool; move it aside before deploying a new pool`);
  if (st.approvedVersion === "0") {
    if (st.approvedRoot !== st.emptyRoot) stop("initial approved root is not the empty-tree root");
    if (!existing) writeJson(labelsPath, { schema: "veilo-approved-labels-v1", pool: a.poolState, rule: "operator approves labels of finalized, inserted deposits made by the configured synthetic/test participants; no sanctions or compliance screening", labels: [], root: st.emptyRoot });
  } else if (existing?.root !== st.approvedRoot) stop("on-chain approved root differs from the published approved-labels file");
  p.steps["approval-root"] = {
    state: "done",
    details: { approvedRoot: st.approvedRoot, version: st.approvedVersion, note: "initialize_pool sets the empty approved root (version 0); no transaction is needed until a deposit is inserted and approved", labelsFile: relative(rootDir, labelsPath).split("\\").join("/") },
    at: now(),
  };
  saveProgress(p);
  console.log(`  approval-root: on-chain approved root version ${st.approvedVersion} = published list (${relative(rootDir, labelsPath)})`);
}

async function stepManifest(p: Progress, roles: RolesFile, a: Addresses, binary: Uint8Array, mintInfo: ReturnType<typeof decodeMint>, feePayer: string): Promise<void> {
  const manifestPath = config.pool.deploymentManifestPath;
  const st = await verifyPool(roles, a);
  const circuits = JSON.parse(readFileSync(join(rootDir, "artifacts", "circuits", "manifest.json"), "utf8")) as { circuits: Record<string, Record<string, unknown>> };
  const pick = (name: string) => {
    const c = circuits.circuits[name]!;
    const keys = ["name", "sourceSha256", "circomVersion", "compilerFlags", "constraints", "nPublic", "publicInputOrder", "r1csSha256", "wasmSha256", "zkeySha256", "vkeyJsonSha256", "vkRustSha256", "ptau", "setup"];
    return Object.fromEntries(keys.map((k) => [k, c[k]]));
  };
  const deploySig = (p.steps["deploy-program"]?.details?.deploySignature as string | null | undefined) ?? p.steps["deploy-program"]?.outcome?.signature ?? null;
  const sig = (s: StepName) => p.steps[s]?.outcome?.signature ?? p.steps[s]?.sent?.signature ?? null;
  const manifest = {
    schemaVersion: 1,
    protocolVersion: 1,
    encodingVersion: "v1",
    network: { cluster: "devnet", caip2: config.network.caip2, genesisHash: config.network.genesisHash, genesisHashHex: GENESIS_HEX },
    program: {
      programId: a.programId,
      programDataAddress: a.programData,
      upgradeAuthority: roles.roles.deployer.publicKey,
      binarySha256: sha256Hex(binary),
      binaryBytes: binary.length,
      maxLen: binary.length,
      sbpfVersion: "v3",
      anchorVersion: "1.2.1",
      solanaToolsVersion: "agave 4.1.2, platform-tools v1.57",
      rustToolchain: "1.97.1",
      groth16SolanaVersion: "0.2.0",
      deploySignature: deploySig ?? "",
    },
    pool: { poolId: roles.poolId, poolState: a.poolState, vaultAuthority: a.vaultAuthority, vault: a.vault, approvalState: a.approvalState, initSignature: sig("initialize-pool") ?? "" },
    token: { mint, decimals: 6, tokenProgram: TOKEN_PROGRAM, mintKind: "devnet-usdc", freezeAuthority: mintInfo.freezeAuthority },
    crypto: {
      curve: "bn254",
      scalarField: SCALAR_FIELD,
      proofSystem: "groth16",
      hash: { name: "poseidon-circomlib", sbox: 5, fullRounds: 8, partialRounds: { "2": 57, "3": 56 }, arities: [2, 3] },
      labelDomain: "veilo/label/v1",
      intentDomain: "veilo/intent/v1",
      contextHash: "sha256-first31-be",
      vectorsFile: "artifacts/vectors/v1.json",
      vectorsSha256: sha256Hex(new Uint8Array(readFileSync(join(rootDir, "artifacts", "vectors", "v1.json")))),
    },
    trees: { commitmentDepth: 16, approvedDepth: 16, rootHistory: 32, emptyRoot: st.emptyRoot, capacity: 65536, changeReserve: 1024, queueMaxLiveDeposits: 64 },
    circuits: { spend: pick("spend"), insert: pick("insert"), exit: pick("exit") },
    bounds: {
      minDeposit: st.minDeposit,
      maxDeposit: st.maxDeposit,
      liabilityCap: st.liabilityCap,
      maxRelayerFee: st.maxRelayerFee,
      maxIntentSlots: 750,
      hardMaxDeposit: "20000000",
      hardLiabilityCap: "100000000",
      hardMaxRelayerFee: "100000",
    },
    authorities: {
      deployer: roles.roles.deployer.publicKey,
      configAuthority: roles.roles.configAuthority.publicKey,
      approvalAuthority: roles.roles.approvalAuthority.publicKey,
      sponsor: roles.roles.sponsor.publicKey,
      relayer: roles.roles.sponsor.publicKey,
    },
    rootHistoryRule: ROOT_HISTORY_RULE,
    signatures: Object.fromEntries(
      [
        ["fundRoles", sig("fund-roles")],
        ["deploy", deploySig],
        ["initializePool", sig("initialize-pool")],
        ["merchantAta", sig("merchant-ata")],
      ].filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""),
    ),
    gateway: { merchantAddress: roles.roles.merchant.publicKey, merchantAta: a.merchantAta, facilitatorFeePayer: feePayer },
    createdAt: now(),
  };
  parseDeploymentManifest(manifest);
  const pins = circuits.circuits as unknown as Parameters<typeof assertManifestMatches>[1]["circuitHashes"];
  assertManifestMatches(parseDeploymentManifest(manifest), { programId: a.programId, poolId: roles.poolId, mint, circuitHashes: pins });

  if (existsSync(manifestPath)) {
    const old = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof manifest;
    const same = (x: typeof manifest) => JSON.stringify({ ...x, createdAt: "", signatures: {} });
    if (same(old) !== same(manifest)) stop(`${relative(rootDir, manifestPath)} exists and differs from the verified chain state; refusing to overwrite it`);
    console.log(`  manifest: ${relative(rootDir, manifestPath)} already recorded and consistent`);
  } else {
    writeJson(manifestPath, manifest);
    const check = await verifyDeployment({ manifestPath, repoRoot: rootDir, programId: a.programId, poolId: roles.poolId, mint, chain: createRpcRelayerChain(config.network.rpcUrl) });
    if (check.state !== "verified") {
      renameSync(manifestPath, `${manifestPath}.rejected`);
      stop(`relayer verification of the new manifest failed: ${check.state === "mismatch" ? check.reason : check.reason}`);
    }
    console.log(`  manifest: wrote ${relative(rootDir, manifestPath)} (relayer verifyDeployment: verified)`);
  }
  p.steps.manifest = { state: "done", details: { path: relative(rootDir, manifestPath).split("\\").join("/") }, at: now() };
  saveProgress(p);
  const env = fillEnv({
    POOL_PROGRAM_ID: a.programId,
    POOL_ID: roles.poolId,
    SPONSOR_KEY_PATH: roles.roles.sponsor.keyPath,
    APPROVED_PARTICIPANTS: PARTICIPANTS.map((k) => roles.roles[k].publicKey).join(","),
    GATEWAY_MERCHANT_ADDRESS: roles.roles.merchant.publicKey,
    GATEWAY_MERCHANT_ATA: a.merchantAta,
  });
  console.log(`  .env: set ${env.set.join(", ") || "nothing"}; unchanged ${env.unchanged.join(", ") || "-"}${env.conflicts.length ? `; CONFLICT (left as is, check manually): ${env.conflicts.join(", ")}` : ""}`);
}

async function fundTestUsdc(roles: RolesFile, amountEach: bigint, funding: KeyPairSigner | null, fundingAddr: string): Promise<void> {
  const src = await ata(fundingAddr, mint);
  const srcAcct = await getAccount(rpc, src);
  if (!srcAcct) stop(`funding wallet has no canonical ATA ${src} for the pinned mint`);
  const s = decodeTokenAccount(srcAcct!.data);
  if (srcAcct!.owner !== TOKEN_PROGRAM || s.mint !== mint || s.owner !== fundingAddr) stop("funding ATA owner/mint mismatch");
  const rows: Array<{ role: string; owner: string; ata: Address; balance: bigint; exists: boolean; amount: bigint }> = [];
  for (const k of PARTICIPANTS) {
    const owner = roles.roles[k].publicKey;
    const dst = await ata(owner, mint);
    const acct = await getAccount(rpc, dst);
    const balance = acct ? decodeTokenAccount(acct.data).amount : 0n;
    rows.push({ role: k, owner, ata: dst, balance, exists: acct !== null, amount: balance >= amountEach ? 0n : amountEach - balance });
  }
  const total = rows.reduce((x, r) => x + r.amount, 0n);
  const ataRent = await rentFor(rpc, 165);
  const solNeeded = BigInt(rows.filter((r) => !r.exists).length) * ataRent + LAMPORTS_PER_SIGNATURE * 2n;
  console.log(`\nTest-USDC funding of synthetic participants (${usdc(amountEach)} each, from ${fundingAddr} ATA ${src}, balance ${usdc(s.amount)})`);
  for (const r of rows) console.log(`  ${r.role.padEnd(11)} ${r.owner} ATA ${r.ata} balance ${usdc(r.balance)} → transfer ${usdc(r.amount)}${r.exists ? "" : " (+ create ATA)"}`);
  console.log(`  total ${usdc(total)}; SOL for ATA rent + fee ≈ ${sol(solNeeded)}`);
  if (total > s.amount) stop(`funding ATA holds ${usdc(s.amount)}, needs ${usdc(total)}`);
  if (total === 0n) {
    console.log("  nothing to transfer");
    return;
  }
  if (!execute || !funding) {
    console.log("  dry run: nothing signed. Execute with --fund-test-usdc --funding <keypair> --execute --confirm");
    return;
  }
  acquireRunLock(`${DEPLOY_PROGRESS_PATH}.lock`);
  const roles2 = roles;
  const p = loadProgress(roles2);
  if (p.steps["fund-test-usdc"]?.state === "done") {
    // A completed transfer is not repeated automatically; balances are already shown above.
    console.log(`  fund-test-usdc already done (${p.steps["fund-test-usdc"].sent?.signature}); participants spent below target — transfer again only by deleting that step from devnet.progress.json deliberately`);
    return;
  }
  await txStep(
    p,
    "fund-test-usdc",
    funding,
    [],
    async () => rows.filter((r) => r.amount > 0n).flatMap((r) => [createAtaIdempotentIx(funding.address, r.ata, address(r.owner), mint), transferCheckedIx(src, mint, r.ata, funding.address, r.amount, 6)]),
    { perParticipant: amountEach.toString(), transfers: rows.map((r) => ({ role: r.role, ata: r.ata, amount: r.amount.toString() })) },
  );
}

// ---------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const roles = readRoles();
  console.log(`Veilo devnet deployment — ${execute ? "EXECUTE (signing enabled)" : "DRY RUN (read-only, nothing is signed)"}`);
  console.log(`RPC ${redactUrl(config.network.rpcUrl)}`);
  const identity = await verifyNetwork(config);
  console.log(`network profile: ${identity.label}`);
  const mintAcct = await getAccount(rpc, mint);
  if (!mintAcct || mintAcct.owner !== TOKEN_PROGRAM) stop("mint is missing or not owned by the original SPL Token program");
  const mintInfo = decodeMint(mintAcct!.data);
  if (mintInfo.decimals !== 6 || !mintInfo.initialized) stop("mint must be initialized with 6 decimals");
  console.log(`chain: genesis ${identity.genesisHash} (${config.network.caip2}); mint ${mint} owner ${mintAcct!.owner} decimals ${mintInfo.decimals} freeze authority ${mintInfo.freezeAuthority ?? "none"} (disclosed risk)`);

  const fundingAddr = fundingAddress();
  if (hasFlag("--fund-test-usdc")) {
    if (!fundingAddr) stop("pass --funding <keypair> or set FUNDING_KEY_PATH");
    const amt = BigInt(argValue("--usdc-per-participant") ?? "200000");
    if (amt <= 0n || amt > 2_000_000n) stop("--usdc-per-participant must be 1..2,000,000 base units (small test amounts only)");
    await fundTestUsdc(roles, amt, execute ? await fundingSigner() : null, fundingAddr!);
    return;
  }

  const { binary, problems } = preflightLocal(roles);
  if (problems.length > 0) stop(`local preflight failed:\n  - ${problems.join("\n  - ")}`);
  const a = await addresses(roles);
  const cs = await chainState(roles, a, binary);
  const support = checkFacilitatorSupport(await fetchFacilitatorSupported(config.network.facilitatorUrl), { network: config.network.caip2, mint });
  const configuredFeePayer = process.env.GATEWAY_FACILITATOR_FEE_PAYER?.trim();
  if (!support.supported) stop(`facilitator ${config.network.facilitatorUrl} does not support exact on devnet for the mint: ${support.reason}`);
  const feePayer = configuredFeePayer && support.feePayers.includes(configuredFeePayer) ? configuredFeePayer : support.feePayers[0]!;

  console.log("\nRoles (public keys; key files under work/keys/devnet, never printed):");
  for (const [k, r] of Object.entries(roles.roles)) console.log(`  ${k.padEnd(18)} ${r.publicKey}`);
  console.log(`\nAddresses:\n  program        ${a.programId}\n  programData    ${a.programData}\n  pool id        ${roles.poolId}\n  poolState      ${a.poolState}\n  vaultAuthority ${a.vaultAuthority}\n  vault          ${a.vault}\n  approvalState  ${a.approvalState}\n  merchant ATA   ${a.merchantAta}`);
  console.log(`\nBinary ${relative(rootDir, binaryPath())}: ${binary.length} bytes, sha256 ${sha256Hex(binary)}, embeds program id: yes`);
  console.log(`Facilitator ${config.network.facilitatorUrl}: exact/devnet supported, fee payer ${feePayer}`);
  console.log(`On chain: program ${cs.programDeployed ? `deployed (binary match: ${cs.programDataMatches})` : "not deployed"}; pool ${cs.poolInitialized ? "initialized" : "not initialized"}; merchant ATA ${cs.merchantAtaExists ? "exists" : "missing"}; leftover buffer ${sol(cs.bufferLamports)}`);

  const pl = await plan(roles, binary, cs);
  console.log("\nSOL plan (rent from getMinimumBalanceForRentExemption; fees at 5,000 lamports/signature ×2 retry margin):");
  console.log(`  ProgramData rent (45 + ${pl.maxLen} B, locked)   ${sol(pl.rent.programData!)}`);
  console.log(`  Program account rent (locked)               ${sol(pl.rent.program!)}`);
  console.log(`  Deploy buffer rent (refunded at deploy)     ${sol(pl.rent.buffer!)}`);
  console.log(`  Deploy fees (~${Math.ceil(pl.binaryBytes / WRITE_CHUNK)} write txs)              ${sol(pl.fees.deploy!)}`);
  console.log(`  initialize_pool rent (PoolState+Approval+vault) ${sol(pl.rent.poolState! + pl.rent.approvalState! + pl.rent.vault!)}`);
  console.log(`  merchant ATA rent                           ${sol(pl.rent.merchantAta!)}`);
  console.log(`  peak deployer during deploy                 ${sol(pl.peakDeployer)}`);
  console.log(`  locked after deployment                     ${sol(pl.lockedAfter)}`);
  console.log("Role top-ups (target − current finalized balance):");
  for (const t of pl.topUps) console.log(`  ${t.role.padEnd(18)} ${t.address} current ${sol(t.current)} target ${sol(t.target)} → ${sol(t.amount)}`);
  const fundingBal = fundingAddr ? await lamportsOf(rpc, fundingAddr) : null;
  console.log(`Funding wallet ${fundingAddr ?? "(not given: --funding <keypair> or FUNDING_KEY_PATH)"}: balance ${fundingBal === null ? "?" : sol(fundingBal)}, needs ${sol(pl.fundingNeeded)}${fundingBal !== null ? `, remaining after ≈ ${sol(fundingBal - pl.fundingNeeded)}` : ""}`);
  if (fundingBal !== null && fundingBal < pl.fundingNeeded) stop(`funding shortfall: ${sol(pl.fundingNeeded - fundingBal)}`);

  if (execute) acquireRunLock(`${DEPLOY_PROGRESS_PATH}.lock`);
  const progress = loadProgress(roles);
  if (!execute) {
    const pending = STEP_NAMES.filter((s) => s !== "fund-test-usdc").map((s) => `${s}: ${progress.steps[s]?.state ?? "pending"}`);
    console.log(`\nSteps: ${pending.join("; ")}`);
    console.log("DRY RUN complete: nothing was signed or sent. Execute with: pnpm deploy:devnet -- --funding <keypair> --execute --confirm");
    return;
  }
  if (!fundingAddr) stop("--funding <keypair> (or FUNDING_KEY_PATH) is required to execute");
  const funding = (await fundingSigner())!;
  const deployer = await roleSigner(roles, "deployer");
  console.log("\nExecuting:");
  await stepFundRoles(progress, pl, funding);
  await stepDeploy(progress, roles, a, binary, await chainState(roles, a, binary));
  await stepInitialize(progress, roles, a, deployer, await chainState(roles, a, binary));
  await stepMerchantAta(progress, roles, a, deployer, await chainState(roles, a, binary));
  await stepApprovalRoot(progress, roles, a);
  await stepManifest(progress, roles, a, binary, mintInfo, feePayer);
  const rentSummary = {
    deployerAfter: (await lamportsOf(rpc, roles.roles.deployer.publicKey)).toString(),
    fundingAfter: (await lamportsOf(rpc, fundingAddr!)).toString(),
  };
  writeJson(join(EVIDENCE_DIR, "m2-deploy.json"), {
    profile: PROFILE,
    kind: "M2 devnet deployment evidence",
    programId: a.programId,
    programExplorer: explorerAddress(a.programId),
    poolState: a.poolState,
    vault: a.vault,
    approvalState: a.approvalState,
    merchantAta: a.merchantAta,
    binarySha256: sha256Hex(binary),
    binaryBytes: binary.length,
    plannedLamports: { rent: pl.rent, fees: pl.fees, lockedAfter: pl.lockedAfter, peakDeployer: pl.peakDeployer },
    balancesAfter: rentSummary,
    steps: progress.steps,
    attempts: progress.attempts,
  });
  console.log(`\nDeployment complete. Evidence: ${relative(rootDir, join(EVIDENCE_DIR, "m2-deploy.json"))}; manifest: ${relative(rootDir, config.pool.deploymentManifestPath)}`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    const e = error as Error;
    console.error(`\ndeploy:devnet stopped: ${e.name === "Stop" ? "" : `${e.name}: `}${e.message}`);
    process.exit(1);
  },
);
