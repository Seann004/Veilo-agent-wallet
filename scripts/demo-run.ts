// pnpm demo:run — the integrated demo through the real backend services (no dashboard events).
//
//   pnpm demo:run                                  devnet readiness check and plan; read-only, no
//                                                  signing, no OpenRouter call
//   pnpm demo:run -- --execute --confirm           devnet run (signs deposits/approval/exit with the
//                                                  funding wallet as demo owner; real bounded inference)
//   pnpm demo:run -- --local-rehearsal             same flow on a loopback test validator with
//                                                  throwaway keys and the FIXTURE provider
//
// Every step is recorded in a state file before its side effect, so a rerun after a 429 or a
// timeout resumes the same run: deposits are reconciled by signature, purchases and tasks by their
// stable idempotency keys, and nothing is signed twice for one step.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { address, signature as toSignature, type KeyPairSigner } from "@solana/kit";
import { DEFAULT_AGENTS, DEFAULT_WORKSPACE_POLICY, DEMO_TOKEN_MINT, findRepoRoot, loadConfig, loadDotEnv, redactUrl, verifyChainIdentity, type VeiloConfig } from "@veilo/contracts";
import { GATEWAY_CATALOG, computeRequestDigest } from "@veilo/contracts/gateway";
import { checkFacilitatorSupport, fetchFacilitatorSupported } from "@veilo/x402-client";
import { openSqliteReadonly } from "../packages/db/src/index";
import { getPoseidon, type DeploymentManifest } from "../packages/privacy-sdk/src/index";
import { PLANNING_MAX_INPUT_TOKENS, PLANNING_MAX_OUTPUT_TOKENS } from "../services/gateway/src/planning";
import { pinnedModel, worstCaseMicroUsd } from "../services/gateway/src/provider/pinned-models";
import { createRpcRelayerChain } from "../services/relayer/src/chain";
import { openRelayerDb } from "../services/relayer/src/db";
import { verifyDeployment } from "../services/relayer/src/deployment";
import { Indexer } from "../services/relayer/src/indexer";
import { ensureOwnerServiceSecret } from "../services/wallet/src/secret";
import { evaluateDemoAcceptance, merchantSignatures, tokenCreditTo, type AcceptanceReceipt, type AcceptanceResult } from "./demo/acceptance";
import { approveInsertedDeposits } from "./demo/approve";
import { ata, awaitTx, decodeTokenAccount, explorerAddress, explorerTx, getAccount, hasFlag, lamportsOf, loadSigner, makeRpc, publicKeyOfKeyFile, readJsonOr, repoPath, sendWire, sleep, sol, usdc, writeJson, type Rpc, type SentTx } from "./devnet/lib";
import { fileSecrets, keypairSecrets, scanDir, type SecretValue } from "./evidence/scan";
import { mintTestUsdc } from "./local-stack/chain";
import { ensureTokenFile, signTextWithKeyFile } from "./local-stack/keys";
import { OwnerClient, WorkerClient, signWire, type Reply } from "./local-stack/owner-client";
import { ServiceProcesses } from "./local-stack/services";
import { createLocalStack, type LocalStack } from "./local-stack/stack";

const rootDir = findRepoRoot();
const LOCAL = hasFlag("--local-rehearsal");
const execute = LOCAL || (hasFlag("--execute") && hasFlag("--confirm"));
if (!LOCAL && hasFlag("--execute") !== hasFlag("--confirm")) {
  console.error("--execute and --confirm must be given together; without both nothing is signed");
  process.exit(2);
}

// ---------------------------------------------------------------------------------------
// Plan: amounts follow the seeded SKU catalog; one note per private purchase.

const CREDIT_PACK = GATEWAY_CATALOG["inference-credit-pack"].x402Amount!;
const RESEARCH = GATEWAY_CATALOG["research-expanded"].x402Amount!;
const RESEARCH_BASIC = GATEWAY_CATALOG["research-basic"].x402Amount!;
const CONTENT = GATEWAY_CATALOG["content-package"].x402Amount!;
const NOTE = 1_000_000n;
const DEPOSITS = [NOTE, NOTE, NOTE];
const QUESTION = "What makes community repair cafes succeed, and what do they measurably achieve?";
const CAMPAIGN = { topic: "Community repair cafes", audience: "Neighbourhood residents and local councils", channels: ["LinkedIn", "Newsletter", "Instagram"], voice: "Warm, practical and evidence-led", deliverables: "Three channel drafts and a seven-day content calendar" };
const MAX_PLANNING_PER_TASK = 2;

function inferenceWorstCaseMicro(model: string): { total: bigint; lines: Array<{ call: string; micro: bigint }> } {
  const m = pinnedModel(model);
  if (!m) throw new Error(`model ${model} is not an allowlisted pinned model`);
  const sku = (s: "analyze" | "content-package") => worstCaseMicroUsd(m, GATEWAY_CATALOG[s].maxInputTokens!, GATEWAY_CATALOG[s].maxOutputTokens!);
  const planning = worstCaseMicroUsd(m, PLANNING_MAX_INPUT_TOKENS, PLANNING_MAX_OUTPUT_TOKENS);
  const lines = [
    { call: `Prince planning (sponsored, ≤${MAX_PLANNING_PER_TASK})`, micro: planning * BigInt(MAX_PLANNING_PER_TASK) },
    { call: "Prince analyze (prepaid credits)", micro: sku("analyze") },
    { call: "Prince per-call analyze fallback (only if prepaid is refused)", micro: sku("analyze") },
    { call: `Mira planning (sponsored, ≤${MAX_PLANNING_PER_TASK})`, micro: planning * BigInt(MAX_PLANNING_PER_TASK) },
    { call: "Mira content-package (direct x402)", micro: sku("content-package") },
  ];
  return { total: lines.reduce((a, l) => a + l.micro, 0n), lines };
}

/** Real-dollar exposure already recorded by live (non-fixture) provider calls in known gateway ledgers. */
function priorLiveOperatorExposure(paths: string[]): { micro: bigint; sources: string[] } {
  let micro = 0n;
  const sources: string[] = [];
  for (const p of [...new Set(paths)]) {
    if (!existsSync(p)) continue;
    let db;
    try {
      db = openSqliteReadonly(p);
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(CASE WHEN l.state IN ('reserved','uncertain') THEN l.worst_case_micro WHEN l.state = 'settled' THEN COALESCE(l.actual_micro, l.worst_case_micro) ELSE 0 END), 0) AS m
           FROM operator_cost_ledger l LEFT JOIN provider_executions e ON e.id = l.execution_id WHERE e.mode IS NULL OR e.mode = 'live'`,
        )
        .get() as { m: bigint | number };
      micro += BigInt(row.m);
      sources.push(`${relative(rootDir, p)}: ${row.m} micro-USD`);
    } catch {
      sources.push(`${relative(rootDir, p)}: not a gateway ledger (skipped)`);
    } finally {
      db?.close();
    }
  }
  return { micro, sources };
}

// ---------------------------------------------------------------------------------------
// Durable run state

interface RunState {
  schema: "veilo-demo-run-v1";
  runId: string;
  profile: "devnet" | "local-rehearsal";
  createdAt: string;
  deposits: Array<{ amount: string; depositId?: string; signature?: string; lastValidBlockHeight?: string; state: "planned" | "sent" | "finalized" | "expired" }>;
  approvals: string[];
  steps: Record<string, { at: string; data?: Record<string, unknown> }>;
  exit?: { exitId: string; noteId: string; signature: string; lastValidBlockHeight: string; value: string; state: "sent" | "finalized" };
}

interface Env {
  dir: string;
  evidenceDir: string;
  owner: { address: string; signer: KeyPairSigner; signText: (m: string) => string };
  rpc: Rpc;
  rpcUrl: string;
  manifest: DeploymentManifest;
  client: OwnerClient;
  controlUrl: string;
  approve: () => Promise<string | null>;
  explorer: (sig: string) => string;
  gatewayDb: string;
  stop: () => Promise<void>;
  secrets: SecretValue[];
  providerMode: "live" | "fixture";
}

const log = (m: string) => console.log(m);
const stamp = () => new Date().toISOString();

function loadState(path: string, profile: RunState["profile"]): RunState {
  const s = readJsonOr<RunState | null>(path, null);
  if (s) return s;
  return { schema: "veilo-demo-run-v1", runId: `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`, profile, createdAt: stamp(), deposits: DEPOSITS.map((a) => ({ amount: a.toString(), state: "planned" })), approvals: [], steps: {} };
}

// ---------------------------------------------------------------------------------------
// Devnet readiness (read-only)

interface Readiness {
  ok: boolean;
  problems: string[];
  config: VeiloConfig;
  manifest: DeploymentManifest | null;
  fundingAddress: string | null;
  budget: { worstCaseMicro: bigint; priorMicro: bigint; ceilingMicro: bigint };
}

async function devnetReadiness(): Promise<Readiness> {
  loadDotEnv({ rootDir, allowProviderSecrets: true });
  const config = loadConfig(process.env, { rootDir });
  const problems: string[] = [];
  const rpc = makeRpc(config.network.rpcUrl);
  log(`RPC ${redactUrl(config.network.rpcUrl)}`);
  const id = await verifyChainIdentity(config);
  log(`chain: devnet genesis ${id.genesisHash}; mint ${id.mint} (${id.mintDecimals} decimals, ${id.mintOwner})`);
  const dep = await verifyDeployment({ manifestPath: config.pool.deploymentManifestPath, repoRoot: rootDir, programId: config.pool.programId, poolId: config.pool.poolId, mint: config.network.mint, chain: createRpcRelayerChain(config.network.rpcUrl) });
  let manifest: DeploymentManifest | null = null;
  if (dep.state !== "verified") problems.push(`deployment ${dep.state}: ${dep.reason}`);
  else {
    manifest = dep.manifest;
    log(`pool: verified — program ${manifest.program.programId}, PoolState ${manifest.pool.poolState}`);
  }
  const gw = (manifest?.gateway ?? {}) as { merchantAddress?: string; merchantAta?: string; facilitatorFeePayer?: string };
  const merchant = process.env.GATEWAY_MERCHANT_ADDRESS?.trim() || gw.merchantAddress;
  if (!merchant) problems.push("GATEWAY_MERCHANT_ADDRESS is not configured");
  else {
    const mAta = await ata(merchant, config.network.mint);
    const acct = await getAccount(rpc, mAta);
    log(`gateway merchant ${merchant}: ATA ${mAta} ${acct ? "exists" : "MISSING"}`);
    if (!acct) problems.push("merchant ATA missing");
  }
  const support = checkFacilitatorSupport(await fetchFacilitatorSupported(config.network.facilitatorUrl), { network: config.network.caip2, mint: config.network.mint, ...(gw.facilitatorFeePayer ? { feePayer: gw.facilitatorFeePayer } : {}) });
  log(`facilitator ${config.network.facilitatorUrl}: ${support.supported ? `exact/devnet supported, fee payer ${support.feePayers.join(", ")}` : `NOT SUPPORTED (${support.reason})`}`);
  if (!support.supported) problems.push(`facilitator: ${support.reason}`);
  const fundingPath = process.env.FUNDING_KEY_PATH?.trim();
  let fundingAddress: string | null = null;
  if (!fundingPath || !existsSync(repoPath(fundingPath))) problems.push("FUNDING_KEY_PATH (demo owner) is not configured or missing");
  else fundingAddress = publicKeyOfKeyFile(repoPath(fundingPath));
  const totalDeposit = DEPOSITS.reduce((a, b) => a + b, 0n);
  if (fundingAddress) {
    const lam = await lamportsOf(rpc, fundingAddress);
    const t = await getAccount(rpc, await ata(fundingAddress, config.network.mint));
    const bal = t ? decodeTokenAccount(t.data).amount : 0n;
    log(`demo owner (funding wallet) ${fundingAddress}: ${sol(lam)}, ${usdc(bal)}`);
    if (bal < totalDeposit) problems.push(`demo owner holds ${usdc(bal)}, needs ${usdc(totalDeposit)}`);
    if (lam < 50_000_000n) problems.push(`demo owner holds ${sol(lam)}, needs ≥ 0.05 SOL for deposit rent, fees and the exit`);
  }
  if (manifest) {
    for (const [role, need] of [["sponsor", 30_000_000n], ["approvalAuthority", 100_000n]] as const) {
      const a = role === "sponsor" ? manifest.authorities.sponsor : manifest.authorities.approvalAuthority;
      const lam = await lamportsOf(rpc, a);
      log(`${role} ${a}: ${sol(lam)}`);
      if (lam < need) problems.push(`${role} holds ${sol(lam)}, needs ≥ ${sol(need)}`);
    }
  }
  if (manifest) await describePoolHistory(config.network.rpcUrl, manifest, fundingAddress);
  for (const [name, p] of [["SPONSOR_KEY_PATH", process.env.SPONSOR_KEY_PATH], ["approval authority key", "work/keys/devnet/approval-authority.json"]] as const) {
    if (!p || !existsSync(repoPath(p))) problems.push(`${name} file missing`);
  }
  for (const c of ["spend", "exit", "insert"]) if (!existsSync(join(rootDir, "circuits", "build", "zkey", `${c}_final.zkey`))) problems.push(`proving key ${c} missing (run pnpm test:circuits)`);
  // Requested allowances: the seeded demo policies must admit every planned purchase.
  const agent = (n: string) => DEFAULT_AGENTS.find((a) => a.name === n)!.policy;
  const checks: Array<[string, boolean]> = [
    ["Shawn per-purchase ≥ credit pack", BigInt(agent("Shawn").maxPurchaseTestUsdc) >= CREDIT_PACK],
    ["Prince per-purchase/task ≥ research-expanded", BigInt(agent("Prince").maxPurchaseTestUsdc) >= RESEARCH && BigInt(agent("Prince").taskLimitTestUsdc) >= RESEARCH],
    ["Prince task credits ≥ analyze", BigInt(agent("Prince").taskCreditUnits) >= GATEWAY_CATALOG.analyze.prepaidUnits!],
    ["Mira per-purchase/task ≥ content-package", BigInt(agent("Mira").maxPurchaseTestUsdc) >= CONTENT && BigInt(agent("Mira").taskLimitTestUsdc) >= CONTENT],
    ["workspace lifetime and 24 h ≥ planned spend", BigInt(DEFAULT_WORKSPACE_POLICY.lifetimeTestUsdc) >= CREDIT_PACK + RESEARCH + CONTENT && BigInt(DEFAULT_WORKSPACE_POLICY.rolling24hTestUsdc) >= CREDIT_PACK + RESEARCH + CONTENT],
  ];
  log(`allowances (seeded demo policies): ${checks.map(([n, ok]) => `${n} ${ok ? "ok" : "NO"}`).join("; ")}`);
  for (const [n, ok] of checks) if (!ok) problems.push(`allowance: ${n}`);
  // Provider readiness from configuration only: this check never calls OpenRouter.
  const keySet = Boolean(config.openRouterApiKey);
  const ceiling = config.inference.operatorMaxRealUsdMicro;
  const model = config.inference.inferenceModelId;
  log(`provider: OpenRouter key ${keySet ? "set" : "UNSET"}; OPERATOR_MAX_REAL_USD_MICRO ${ceiling}; inference model ${model ?? "unset"}, planner ${config.inference.plannerModelId ?? "unset"} (no provider call made)`);
  if (!config.inference.realInferenceEnabled) problems.push("BLOCKED real-demo gate: real inference disabled (provider key or OPERATOR_MAX_REAL_USD_MICRO missing)");
  if (!model || !pinnedModel(model) || !config.inference.plannerModelId || !pinnedModel(config.inference.plannerModelId)) problems.push("inference/planner model is not an allowlisted pinned model");
  const worst = model && pinnedModel(model) ? inferenceWorstCaseMicro(model) : { total: 0n, lines: [] };
  const prior = priorLiveOperatorExposure([config.paths.gatewayDatabase, join(rootDir, "secrets", "gateway.sqlite"), join(rootDir, "data", "gateway.sqlite"), ...demoGatewayDbs()]);
  log("\nOpenRouter budget guard (pinned tariff, worst case = max input + max output tokens per call):");
  for (const l of worst.lines) log(`  ${l.call.padEnd(62)} ≤ ${l.micro} micro-USD`);
  log(`  worst case total ${worst.total} micro-USD ($${(Number(worst.total) / 1e6).toFixed(6)}); already used by live calls ${prior.micro} micro-USD; ceiling ${ceiling}`);
  for (const s of prior.sources) log(`    ${s}`);
  if (prior.sources.length === 0) log("    no gateway ledger on this machine; live calls recorded on other machines are not counted, so keep a provider-side spend limit on the key");
  if (worst.total + prior.micro > ceiling) problems.push(`worst-case inference ${worst.total} + prior ${prior.micro} micro-USD exceeds OPERATOR_MAX_REAL_USD_MICRO ${ceiling}`);
  return { ok: problems.length === 0, problems, config, manifest, fundingAddress, budget: { worstCaseMicro: worst.total, priorMicro: prior.micro, ceilingMicro: ceiling } };
}

/**
 * Read-only replay of the pool: reports earlier activity by the demo owner and whether the published
 * approved-label list matches the on-chain approved root. Neither blocks a run: the approval step
 * republishes the list from chain history, and a new run uses its own notes and databases.
 */
async function describePoolHistory(rpcUrl: string, manifest: DeploymentManifest, owner: string | null): Promise<void> {
  const labelsPath = repoPath(process.env.APPROVED_LABELS_PATH?.trim() || "artifacts/deployment/approved-labels.json");
  const db = openRelayerDb(":memory:");
  try {
    const indexer = new Indexer(db, createRpcRelayerChain(rpcUrl), await getPoseidon(), address(manifest.program.programId), address(manifest.pool.poolState), address(manifest.pool.approvalState), labelsPath);
    const { view } = await indexer.replay();
    log(`pool history: ${view.deposits.length} deposits, ${view.spends.length} private spends, ${view.exits.length} public exits; approved root version ${view.approved.version}`);
    if (!view.approved.consistent) {
      log(`  note: ${relative(rootDir, labelsPath)} does not match the on-chain approved root (it was last written on another machine). The approval step rebuilds the list from chain history before approving new deposits.`);
    }
    const ownerDeposits = owner ? view.deposits.filter((d) => d.refundAuthority === owner).length : 0;
    if (ownerDeposits > 0 && !existsSync(join(rootDir, "work", "demo", "devnet-state.json"))) {
      log(`  note: the demo owner already has ${ownerDeposits} deposit(s) in this pool, but no work/demo/devnet-state.json exists here. An earlier run's state and evidence (work/demo/, artifacts/evidence/demo-<runId>/) are on another machine; --execute here starts a NEW run with new deposits and payments.`);
    }
  } catch (err) {
    log(`pool history: replay unavailable (${(err as Error).message})`);
  } finally {
    db.close();
  }
}

function demoGatewayDbs(): string[] {
  const base = join(rootDir, "work", "demo", "devnet");
  if (!existsSync(base)) return [];
  return readdirSync(base).map((d) => join(base, d, "data", "gateway.sqlite")).filter(existsSync);
}

function printPlan(): void {
  log("\nPlan (backend paths, PRD §16):");
  log(`  a. owner deposits ${DEPOSITS.map((d) => usdc(d)).join(" + ")} as separate notes; relayer inserts; approval authority approves the owner's labels`);
  log(`  b. Shawn: gateway credits start at 0 (< 200,000 threshold); "Check now" runs the scheduled check → private pool → fresh wallet → x402 ${usdc(CREDIT_PACK)} → one 1,000,000-credit issuance`);
  log(`  c. Prince: research task; buys research-expanded (${usdc(RESEARCH)}) or research-basic (${usdc(RESEARCH_BASIC)}) via private x402; analyze via prepaid credits (real bounded inference); cited brief; requests a handoff to Mira`);
  log(`  d. owner approves the handoff; Mira buys content-package directly via private x402 (${usdc(CONTENT)}), real inference → three drafts + seven-day calendar`);
  log("  e. duplicate check: the same research purchase request and a second Shawn check create no new payment");
  log("  f. Mira's allowance is lowered below one package; two concurrent requests are both rejected; Prince is revoked and a new request is refused");
  log("  g. owner public exit of a change note back to the owner wallet, with the privacy warning");
  log(`  test USDC: deposits ${usdc(DEPOSITS.reduce((a, b) => a + b, 0n))}; merchant spend ≤ ${usdc(CREDIT_PACK + RESEARCH + CONTENT)}; the exit returns the largest spendable change note (0.5–0.9 test USDC depending on the research dataset chosen)`);
  log("  SOL (measured on devnet 2026-10-17): owner 3 deposits × 0.00274312 + exit 0.00090924 = 0.0091386; sponsor 3 × (fresh-payer ATA 0.00149344 + spend 0.00221988) + 6 inserts × 0.000005 = 0.0111700; approval authority 2 × 0.000005 → ≈ 0.0203 SOL total");
}

// ---------------------------------------------------------------------------------------
// Environments

async function devnetEnv(r: Readiness, state: RunState): Promise<Env> {
  const config = r.config;
  const manifest = r.manifest!;
  const dir = join(rootDir, "work", "demo", "devnet", state.runId);
  const secrets = join(dir, "secrets");
  const data = join(dir, "data");
  mkdirSync(data, { recursive: true });
  ensureOwnerServiceSecret(join(secrets, "owner-service.secret"));
  ensureTokenFile(join(secrets, "control-service.credential"), "vcs");
  ensureTokenFile(join(secrets, "wallet-service.credential"), "vws");
  const owner = r.fundingAddress!;
  const fundingKey = repoPath(process.env.FUNDING_KEY_PATH!.trim());
  const base = 4700;
  const ports = { dashboard: base, control: base + 1, runner: base + 2, wallet: base + 3, gateway: base + 4, relayer: base + 5 };
  const rel = (p: string) => relative(rootDir, p).split("\\").join("/");
  const gw = manifest.gateway as { merchantAddress: string; facilitatorFeePayer: string };
  const ceiling = r.budget.ceilingMicro - r.budget.priorMicro;
  const env: Record<string, string> = {
    DEVNET_RPC_URL: config.network.rpcUrl,
    EXPECTED_DEVNET_GENESIS_HASH: config.network.genesisHash,
    DEMO_TOKEN_MINT: config.network.mint,
    FACILITATOR_URL: config.network.facilitatorUrl,
    POOL_PROGRAM_ID: manifest.program.programId,
    POOL_ID: manifest.pool.poolId,
    DEPLOYMENT_MANIFEST_PATH: rel(config.pool.deploymentManifestPath),
    PLANNER_MODEL_ID: config.inference.plannerModelId!,
    INFERENCE_MODEL_ID: config.inference.inferenceModelId!,
    // The gateway's own ceiling is the remainder of the operator's total ceiling.
    OPERATOR_MAX_REAL_USD_MICRO: ceiling.toString(),
    SPONSOR_KEY_PATH: process.env.SPONSOR_KEY_PATH!.trim(),
    OWNER_SERVICE_SECRET_PATH: rel(join(secrets, "owner-service.secret")),
    CONTROL_DATABASE_PATH: rel(join(data, "control.sqlite")),
    GATEWAY_DATABASE_PATH: rel(join(data, "gateway.sqlite")),
    RELAYER_DATABASE_PATH: rel(join(data, "relayer.sqlite")),
    VEILO_DATA_DIR: rel(data),
    VEILO_SECRETS_DIR: rel(secrets),
    VEILO_BIND_HOST: "127.0.0.1",
    DASHBOARD_PORT: String(ports.dashboard),
    CONTROL_PORT: String(ports.control),
    RUNNER_PORT: String(ports.runner),
    WALLET_PORT: String(ports.wallet),
    GATEWAY_PORT: String(ports.gateway),
    RELAYER_PORT: String(ports.relayer),
    CONTROL_SERVICE_CREDENTIAL_PATH: rel(join(secrets, "control-service.credential")),
    WALLET_SERVICE_CREDENTIAL_PATH: rel(join(secrets, "wallet-service.credential")),
    RUNNER_WORKER_CREDENTIAL_PATH: rel(join(secrets, "runner", "worker-credentials.json")),
    GATEWAY_IDENTITY: "veilo-gateway-devnet",
    GATEWAY_PUBLIC_ORIGIN: `http://127.0.0.1:${ports.gateway}`,
    GATEWAY_MERCHANT_ADDRESS: gw.merchantAddress,
    GATEWAY_FACILITATOR_FEE_PAYER: gw.facilitatorFeePayer,
    USAGE_PERMIT_PUBLIC_KEY_PATH: rel(join(secrets, "gateway", "usage-permit-public.pem")),
    GATEWAY_PLANNING_CREDENTIAL_PATH: rel(join(secrets, "gateway", "planning.token")),
    VEILO_OWNER_PUBKEY: owner,
    CONTROL_USAGE_PERMIT_KEY_PATH: rel(join(secrets, "control", "usage-permit-signing.pem")),
    CONTROL_GATEWAY_ACCOUNT_TOKEN_PATH: rel(join(secrets, "control", "gateway-account.token")),
    OWNER_RECOVERY_ADDRESS: owner,
    RELAYER_SPONSOR_LAMPORT_CAP: "100000000",
    APPROVED_LABELS_PATH: process.env.APPROVED_LABELS_PATH?.trim() || "artifacts/deployment/approved-labels.json",
    APPROVED_PARTICIPANTS: owner,
    VEILO_DASHBOARD_ORIGIN: `http://localhost:${ports.dashboard}`,
    WALLET_NOTE_SYNC_MS: "20000",
  };
  const envFile = join(dir, "demo.env");
  // The provider key is never written to this file; only the gateway process receives it.
  writeFileSync(envFile, `# demo:run ${state.runId} (devnet)\n${Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n")}\n`);
  const seed = spawnSync(process.execPath, ["--import", "tsx", "scripts/demo-seed.ts"], { cwd: rootDir, env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", USERNAME: process.env.USERNAME ?? "", USERDOMAIN: process.env.USERDOMAIN ?? "", TEMP: process.env.TEMP ?? "", VEILO_ENV_FILE: envFile }, encoding: "utf8" });
  if (seed.status !== 0) throw new Error(`demo:seed failed: ${(seed.stderr || seed.stdout).slice(-600)}`);
  const services = new ServiceProcesses({
    envFile,
    logDir: join(dir, "logs"),
    ports,
    env: { control: {}, wallet: {}, relayer: {}, gateway: { OPENROUTER_API_KEY: config.openRouterApiKey ?? "" }, runner: {} },
  });
  log(`services: starting control, wallet, relayer, gateway, runner on ports ${base + 1}-${base + 5} (logs in ${rel(join(dir, "logs"))})`);
  await services.startAll();
  const rpc = makeRpc(config.network.rpcUrl);
  const signer = await loadSigner(fundingKey, owner);
  const client = new OwnerClient(`http://127.0.0.1:${ports.control}`, `http://127.0.0.1:${ports.wallet}`, env.VEILO_DASHBOARD_ORIGIN!);
  const keyDir = join(rootDir, "work", "keys", "devnet");
  return {
    dir,
    evidenceDir: join(rootDir, "artifacts", "evidence", `demo-${state.runId}`),
    owner: { address: owner, signer, signText: (m) => signTextWithKeyFile(fundingKey, m) },
    rpc,
    rpcUrl: config.network.rpcUrl,
    manifest,
    client,
    controlUrl: `http://127.0.0.1:${ports.control}`,
    approve: async () =>
      (
        await approveInsertedDeposits({
          rpc,
          rpcUrl: config.network.rpcUrl,
          manifest,
          labelsPath: repoPath(env.APPROVED_LABELS_PATH!),
          participants: new Set([owner]),
          approvalKeyPath: join(keyDir, "approval-authority.json"),
          workDir: data,
          onSent: (s) => {
            state.approvals.push(s.signature);
            saveState(state);
          },
        })
      ).signature,
    explorer: explorerTx,
    gatewayDb: join(data, "gateway.sqlite"),
    stop: () => services.killAll(),
    secrets: [
      ...(config.openRouterApiKey ? [{ name: "OpenRouter API key", value: config.openRouterApiKey }] : []),
      ...keypairSecrets(fundingKey, "funding wallet"),
      ...readdirSync(keyDir).flatMap((f) => keypairSecrets(join(keyDir, f), `role ${f}`)),
      ...fileSecrets(secretFiles(secrets)),
    ],
    providerMode: "live",
  };
}

function secretFiles(secrets: string): Array<{ path: string; name: string }> {
  return [
    { path: join(secrets, "owner-service.secret"), name: "owner service secret" },
    { path: join(secrets, "control-service.credential"), name: "control credential" },
    { path: join(secrets, "wallet-service.credential"), name: "wallet credential" },
    { path: join(secrets, "control", "gateway-account.token"), name: "gateway account token" },
    { path: join(secrets, "gateway", "planning.token"), name: "planning token" },
    { path: join(secrets, "control", "usage-permit-signing.pem"), name: "usage permit signing key" },
    { path: join(secrets, "runner", "worker-credentials.json"), name: "runner worker credentials" },
  ];
}

async function localEnv(state: RunState): Promise<{ env: Env; stack: LocalStack }> {
  const stack = await createLocalStack({ name: "demo-rehearsal", basePort: 5800, reuse: existsSync(join(rootDir, "work", "demo-rehearsal", "stack.env")) && hasFlag("--resume"), extraEnv: { WALLET_NOTE_SYNC_MS: "4000", CONTROL_PURCHASE_SWEEP_MS: "5000" } });
  const signer = await loadSigner(stack.keys.owner.path);
  // Throwaway test USDC for the local owner (the local mint authority is a throwaway key).
  await mintTestUsdc(stack.rpc, stack.validator.rpcUrl, await loadSigner(stack.keys.deployer.path), await loadSigner(stack.keys.mintAuthority.path), signer.address, DEPOSITS.reduce((a, b) => a + b, 0n) + 1_000_000n);
  const env: Env = {
    dir: stack.dir,
    evidenceDir: join(stack.dir, "evidence", `demo-${state.runId}`),
    owner: { address: signer.address, signer, signText: (m) => signTextWithKeyFile(stack.keys.owner.path, m) },
    rpc: stack.rpc,
    rpcUrl: stack.validator.rpcUrl,
    manifest: stack.manifest,
    client: stack.owner,
    controlUrl: stack.controlUrl,
    approve: async () => ((await stack.approveRoot()) ? "local" : null),
    explorer: (sig) => `local-test-validator:${sig}`,
    gatewayDb: join(stack.dir, "data", "gateway.sqlite"),
    stop: () => stack.close(),
    secrets: [
      ...readdirSync(join(stack.dir, "keys")).flatMap((f) => keypairSecrets(join(stack.dir, "keys", f), `key ${f}`)),
      ...fileSecrets(secretFiles(join(stack.dir, "secrets"))),
      { name: "mock provider key", value: "local-mock-provider" },
    ],
    providerMode: "fixture",
  };
  return { env, stack };
}

// ---------------------------------------------------------------------------------------
// Steps

let STATE_PATH = "";
const saveState = (s: RunState) => writeJson(STATE_PATH, s);

async function step(s: RunState, name: string, fn: () => Promise<Record<string, unknown> | void>): Promise<Record<string, unknown> | undefined> {
  const done = s.steps[name];
  if (done) {
    log(`[${name}] already done (${done.at})`);
    return done.data;
  }
  log(`[${name}]`);
  const data = (await fn()) ?? {};
  s.steps[name] = { at: stamp(), data };
  saveState(s);
  return data;
}

async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, timeoutMs = 600_000, stepMs = 4_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`${what}: not reached within ${Math.round(timeoutMs / 1000)} s; rerun the same command to resume`);
    await sleep(stepMs);
  }
}

async function deposits(e: Env, s: RunState): Promise<Record<string, unknown>> {
  for (const d of s.deposits) {
    if (d.state === "finalized") continue;
    if (d.state === "sent" && d.signature) {
      const r = await awaitTx(e.rpc, { signature: d.signature, lastValidBlockHeight: d.lastValidBlockHeight!, sentAt: stamp() });
      if (r.state === "finalized" && r.outcome.err === null) {
        d.state = "finalized";
        saveState(s);
        continue;
      }
      if (r.state === "pending") throw new Error(`deposit ${d.signature} not finalized yet; rerun later`);
      d.state = "expired";
      saveState(s);
      log(`  deposit ${d.signature} expired unseen; preparing a new one`);
    }
    const prep = await e.client.wallet("POST", "/deposits/prepare", { amount: d.amount });
    if (prep.status !== 201) throw new Error(`deposit prepare: HTTP ${prep.status} ${JSON.stringify(prep.body)}`);
    log(`  privacy: ${String(prep.body.privacyWarning ?? "")}`);
    const signed = await signWire(prep.body.transaction as string, e.owner.signer);
    const fresh = d.state === "expired" ? { amount: d.amount, state: "planned" as const } : d;
    Object.assign(fresh, { depositId: prep.body.depositId, signature: signed.signature, lastValidBlockHeight: prep.body.lastValidBlockHeight, state: "sent" });
    if (fresh !== d) s.deposits.push(fresh);
    saveState(s);
    const reg = await e.client.wallet("POST", "/deposits/register", { depositId: prep.body.depositId, signature: signed.signature });
    if (reg.status !== 200) throw new Error(`deposit register: HTTP ${reg.status}`);
    await sendWire(e.rpc, signed.wire).catch((err: Error) => log(`  send reported ${err.message}; reconciling by signature`));
    const r = await awaitTx(e.rpc, { signature: signed.signature, lastValidBlockHeight: prep.body.lastValidBlockHeight as string, sentAt: stamp() });
    if (r.state !== "finalized" || r.outcome.err !== null) throw new Error(`deposit ${signed.signature}: ${r.state}; rerun to reconcile`);
    fresh.state = "finalized";
    saveState(s);
    log(`  deposit ${usdc(BigInt(d.amount))} finalized ${e.explorer(signed.signature)}`);
  }
  const total = s.deposits.filter((d) => d.state === "finalized").reduce((a, d) => a + BigInt(d.amount), 0n);
  log("  waiting for the relayer to insert the deposits, then approving the owner's labels");
  await until("deposits spendable", async () => {
    const sig = await e.approve();
    if (sig) log(`  update_approved_root ${e.explorer(sig)}`);
    const st = await e.client.notes();
    return BigInt(st.totals.spendable.amount) + BigInt(st.totals.reserved.amount) >= total ? st : null;
  }, 900_000, 8_000);
  return { deposits: s.deposits, approvals: s.approvals };
}

async function purchasesOf(e: Env): Promise<Array<Record<string, unknown> & { id: string; sku: string; agentId: string; states: Record<string, string>; chainAttempts: Array<{ leg: string; signature: string | null; commitment: string }> }>> {
  const r = await e.client.control("GET", "/activity?limit=200");
  return r.body.purchases;
}

async function waitTask(e: Env, taskId: string): Promise<Record<string, unknown>> {
  return until(`task ${taskId}`, async () => {
    const r = await e.client.control("GET", "/tasks?limit=50");
    const t = (r.body.tasks as Array<{ id: string; state: string }>).find((x) => x.id === taskId);
    return t && ["completed", "incomplete", "failed"].includes(t.state) ? (t as Record<string, unknown>) : null;
  }, 900_000, 5_000);
}

function withLinks(e: Env, p: { chainAttempts?: Array<{ signature: string | null }> }) {
  return (p.chainAttempts ?? []).map((a) => ({ ...a, explorer: a.signature ? e.explorer(a.signature) : null }));
}

async function run(e: Env, s: RunState): Promise<{ shawn: string; prince: string; mira: string }> {
  await e.client.login(e.owner.address, e.owner.signText);
  const ws = await e.client.workspace();
  const agentId = (n: string) => (ws.agents as Array<{ id: string; name: string }>).find((a) => a.name === n)!.id;
  const shawn = agentId("Shawn");
  const prince = agentId("Prince");
  const mira = agentId("Mira");

  await step(s, "0-policies", async () => {
    await e.client.activateSeededPolicies();
    // Shawn's scheduled poll stays off until the step that demonstrates it.
    await e.client.control("POST", `/agents/${shawn}/pause`, {});
    const view = await e.client.workspace();
    return { workspacePolicy: (view.policies as Array<Record<string, unknown>>).filter((p) => p.status === "active") };
  });
  await step(s, "a-deposits", () => deposits(e, s));

  await step(s, "b-shawn-topup", async () => {
    const before = await e.client.control("GET", "/balances");
    log(`  gateway credits usable ${before.body.gatewayCredits.usable} (threshold 200,000) — "${before.body.gatewayCredits.label}"`);
    await e.client.control("POST", `/agents/${shawn}/resume`, {});
    const run = await e.client.control("POST", `/agents/${shawn}/run`, { triggerKey: `demo-${s.runId}-shawn` });
    log(`  check: ${JSON.stringify(run.body.check ?? run.body.job?.state)}`);
    const pack = await until("credit pack delivered", async () => {
      const p = (await purchasesOf(e)).find((x) => x.sku === "inference-credit-pack");
      return p && (p.states.fulfilment === "delivered" || p.states.recovery !== "none") ? p : null;
    });
    if (pack.states.fulfilment !== "delivered") throw new Error(`credit pack purchase ended ${JSON.stringify(pack.states)}`);
    const after = await e.client.control("GET", "/balances");
    log(`  credit pack delivered: funding ${pack.chainAttempts.map((a) => `${a.leg} ${a.signature}`).join(", ")}; credits usable ${after.body.gatewayCredits.usable}`);
    return { purchase: { ...pack, chainAttempts: withLinks(e, pack) }, creditsBefore: before.body.gatewayCredits, creditsAfter: after.body.gatewayCredits };
  });

  const princeTask = await step(s, "c-prince-research", async () => {
    const r = await e.client.control("POST", `/agents/${prince}/run`, { objective: QUESTION, input: { handoffToAgentId: mira }, triggerKey: `demo-${s.runId}-prince` });
    if (![200, 202].includes(r.status)) throw new Error(`Prince run: HTTP ${r.status} ${JSON.stringify(r.body)}`);
    log(`  task ${r.body.taskId} queued; the runner executes it`);
    const t = await waitTask(e, r.body.taskId as string);
    log(`  task ${t.state}`);
    return { taskId: r.body.taskId, task: t };
  });

  await step(s, "d-handoff-mira", async () => {
    const h = await until("handoff requested", async () => {
      const r = await e.client.control("GET", "/handoffs");
      return (r.body.items as Array<{ id: string; state: string; toAgentId: string }>).find((x) => x.toAgentId === mira) ?? null;
    }, 120_000);
    if (h.state === "pending_owner") {
      const d = await e.client.control("POST", `/handoffs/${h.id}/decision`, { decision: "approve" });
      if (d.status !== 200) throw new Error(`handoff approval: HTTP ${d.status} ${JSON.stringify(d.body)}`);
    }
    const startDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const r = await e.client.control("POST", `/agents/${mira}/run`, { input: { ...CAMPAIGN, startDate, handoffId: h.id }, triggerKey: `demo-${s.runId}-mira` });
    if (![200, 202].includes(r.status)) throw new Error(`Mira run: HTTP ${r.status} ${JSON.stringify(r.body)}`);
    const t = await waitTask(e, r.body.taskId as string);
    log(`  Mira task ${t.state}`);
    return { handoffId: h.id, taskId: r.body.taskId, task: t };
  });

  await step(s, "e-duplicate-check", async () => {
    const before = await purchasesOf(e);
    const research = before.find((p) => p.sku.startsWith("research-") && p.agentId === prince);
    const worker = new WorkerClient(e.controlUrl, await e.client.workerToken(prince));
    let repeat: Reply | null = null;
    if (research) {
      const taskId = (princeTask?.taskId as string | undefined) ?? "";
      const input = { query: QUESTION };
      repeat = await worker.call("POST", "/purchase-intents", { idempotencyKey: `task:${taskId}:data:${research.sku}`, taskId, serviceId: research.serviceId, sku: research.sku, paymentPath: "private_x402", requestDigest: computeRequestDigest(research.sku, input), input });
    }
    const check = await e.client.control("POST", `/agents/${shawn}/run`, {});
    const after = await purchasesOf(e);
    const newPayments = after.length - before.length;
    log(`  repeated research request → ${repeat ? `HTTP ${repeat.status}, same purchase ${repeat.body.purchase?.id === research?.id}` : "skipped (no research purchase)"}; Shawn check → ${check.body.check?.decision}; new purchases ${newPayments}`);
    if (newPayments !== 0) throw new Error("duplicate check created a new purchase");
    if (repeat && repeat.body.purchase?.id !== research?.id) throw new Error(`repeated research request did not return the same purchase (HTTP ${repeat.status})`);
    return { research: research?.id ?? null, repeat: repeat ? { status: repeat.status, samePurchase: repeat.body.purchase?.id === research?.id, created: repeat.body.created } : null, shawnCheck: check.body.check ?? null, newPurchases: newPayments };
  });

  await step(s, "f-over-budget-and-revoke", async () => {
    const bal = await e.client.control("GET", "/balances");
    const m = (bal.body.agents as Array<{ agentId: string; lifetime: { settled: string; reserved: string } }>).find((a) => a.agentId === mira)!;
    const used = BigInt(m.lifetime.settled) + BigInt(m.lifetime.reserved);
    await e.client.setAgentPolicy(mira, {
      tier: "bounded_automatic",
      lifetimeTestUsdc: (used + 100_000n).toString(),
      rolling24hTestUsdc: "2000000",
      maxPurchaseTestUsdc: "500000",
      taskLimitTestUsdc: "1000000",
      usageAllowanceUnits: "2000000",
      taskCreditUnits: "400000",
      allowedSkus: ["content-package", "summarize", "analyze"],
      allowedPaymentPaths: ["private_x402", "prepaid_credits"],
    });
    const worker = new WorkerClient(e.controlUrl, await e.client.workerToken(mira));
    const svc = (ws.services as Array<{ id: string; skus: Array<{ sku: string; paymentPath: string }> }>).find((x) => x.skus.some((k) => k.sku === "content-package" && k.paymentPath === "private_x402"))!;
    const req = (i: number) => {
      const input = { ...CAMPAIGN, startDate: "2026-11-01", brief: `concurrent request ${i}` };
      return worker.call("POST", "/purchase-intents", { idempotencyKey: `demo-${s.runId}-overbudget-${i}`, serviceId: svc.id, sku: "content-package", paymentPath: "private_x402", requestDigest: computeRequestDigest("content-package", input), input });
    };
    const [a, b] = await Promise.all([req(1), req(2)]);
    const outcomes = [a, b].map((r) => ({ status: r.status, error: r.body.error?.code ?? null, authorization: r.body.purchase?.states?.authorization ?? null }));
    log(`  two concurrent content-package requests with ${usdc(100_000n)} left: ${JSON.stringify(outcomes)}`);
    if (outcomes.some((o) => o.authorization !== null && o.authorization !== "rejected")) throw new Error("an over-budget request was admitted");
    const princeWorker = new WorkerClient(e.controlUrl, await e.client.workerToken(prince));
    const revoke = await e.client.control("POST", `/agents/${prince}/revoke`, {});
    const after = await princeWorker.call("GET", "/worker/catalog");
    log(`  Prince revoked (${revoke.body.agent?.status}); a new tool call after revoke → HTTP ${after.status}`);
    return { overBudget: outcomes, revoke: { status: revoke.status, agentStatus: revoke.body.agent?.status }, afterRevoke: after.status };
  });

  await step(s, "g-owner-exit", async () => {
    if (!s.exit) {
      const st = await until("a spendable change note", async () => {
        const n = await e.client.notes();
        const change = (n.notes as Array<{ id: string; origin: string; state: string; value: { amount: string } }>).filter((x) => x.origin === "change" && x.state === "spendable").sort((x, y) => (BigInt(y.value.amount) > BigInt(x.value.amount) ? 1 : -1));
        return change[0] ?? null;
      }, 600_000, 6_000);
      const prep = await e.client.wallet("POST", "/exits/prepare", { noteId: st.id });
      if (prep.status !== 201) throw new Error(`exit prepare: HTTP ${prep.status} ${JSON.stringify(prep.body)}`);
      log(`  PRIVACY WARNING: ${String(prep.body.privacyWarning ?? "public exit links this note's label, value and refund address to the deposit")}`);
      const signed = await signWire(prep.body.transaction as string, e.owner.signer);
      s.exit = { exitId: prep.body.exitId as string, noteId: st.id, signature: signed.signature, lastValidBlockHeight: prep.body.lastValidBlockHeight as string, value: st.value.amount, state: "sent" };
      saveState(s);
      await e.client.wallet("POST", "/exits/register", { exitId: s.exit.exitId, signature: signed.signature });
      await sendWire(e.rpc, signed.wire).catch((err: Error) => log(`  send reported ${err.message}; reconciling by signature`));
    }
    const r = await awaitTx(e.rpc, { signature: s.exit.signature, lastValidBlockHeight: s.exit.lastValidBlockHeight, sentAt: stamp() } as SentTx);
    if (r.state !== "finalized" || r.outcome.err !== null) throw new Error(`exit ${s.exit.signature}: ${r.state}; rerun to reconcile`);
    s.exit.state = "finalized";
    saveState(s);
    log(`  exit of ${usdc(BigInt(s.exit.value))} to the owner finalized ${e.explorer(s.exit.signature)}`);
    return { exit: { ...s.exit, explorer: e.explorer(s.exit.signature) } };
  });
  await e.client.control("POST", `/agents/${shawn}/pause`, {});
  return { shawn, prince, mira };
}

// ---------------------------------------------------------------------------------------
// Evidence

function inferenceReceipts(gatewayDb: string): Array<AcceptanceReceipt & Record<string, unknown>> {
  if (!existsSync(gatewayDb)) return [];
  const db = openSqliteReadonly(gatewayDb);
  try {
    return db
      .prepare(
        `SELECT e.source_kind AS sourceKind, COALESCE(p.sku, u.sku) AS sku, e.model, e.mode, e.reported_model AS reportedModel, e.state, e.prompt_tokens AS promptTokens, e.completion_tokens AS completionTokens,
                length(e.output_text) AS outputChars, l.purpose, l.worst_case_micro AS worstCaseMicroUsd, l.actual_micro AS actualMicroUsd, l.actual_source AS costSource, e.started_at AS at
         FROM provider_executions e LEFT JOIN operator_cost_ledger l ON l.execution_id = e.id
         LEFT JOIN purchases p ON e.source_kind = 'purchase' AND p.id = e.source_id
         LEFT JOIN usage_operations u ON e.source_kind = 'usage' AND u.id = e.source_id
         ORDER BY e.started_at`,
      )
      .all()
      .map((r) => JSON.parse(JSON.stringify(r, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))) as AcceptanceReceipt & Record<string, unknown>);
  } finally {
    db.close();
  }
}

/** Base units each merchant-leg signature credited to the gateway merchant ATA (finalized transactions only). */
async function merchantCredits(e: Env, purchases: Array<Parameters<typeof merchantSignatures>[0]>): Promise<Record<string, bigint | null>> {
  const gw = e.manifest.gateway as { merchantAddress?: string } | undefined;
  if (!gw?.merchantAddress) return {};
  const merchantAta = await ata(gw.merchantAddress, DEMO_TOKEN_MINT);
  const out: Record<string, bigint | null> = {};
  for (const sig of purchases.flatMap(merchantSignatures)) {
    const tx = await e.rpc.getTransaction(toSignature(sig), { commitment: "finalized", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }).send();
    out[sig] = tokenCreditTo(tx as unknown as Parameters<typeof tokenCreditTo>[0], merchantAta);
  }
  return out;
}

async function writeEvidence(e: Env, s: RunState, agents: { shawn: string; prince: string; mira: string }): Promise<AcceptanceResult> {
  const dir = e.evidenceDir;
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  const activity = await e.client.control("GET", "/activity?limit=200");
  const balances = await e.client.control("GET", "/balances");
  const content = await e.client.control("GET", "/content");
  const tasks = await e.client.control("GET", "/tasks?limit=50");
  const purchases = (activity.body.purchases as Array<Record<string, unknown>>).map((p) => ({
    id: p.id,
    agentId: p.agentId,
    sku: p.sku,
    paymentPath: p.paymentPath,
    price: p.price,
    usage: p.usage,
    states: p.states,
    label: p.label,
    chainAttempts: withLinks(e, p as { chainAttempts?: Array<{ signature: string | null }> }),
    settledAt: p.settledAt,
  }));
  const items = content.body.items as Array<{ id: string; kind: string; title: string; content: string }>;
  for (const a of items) {
    const ext = a.kind === "content_calendar" ? "json" : "md";
    writeFileSync(join(dir, "artifacts", `${a.kind}-${a.id.slice(0, 8)}.${ext}`), a.kind === "content_calendar" ? `${JSON.stringify(JSON.parse(a.content), null, 2)}\n` : `# ${a.title}\n\n${a.content}\n`);
  }
  const receipts = inferenceReceipts(e.gatewayDb);
  const taskRows = tasks.body.tasks as Array<{ id: string; state: string }>;
  const taskOf = (stepName: string) => taskRows.find((t) => t.id === s.steps[stepName]?.data?.taskId);
  const acceptance = evaluateDemoAcceptance({
    providerMode: e.providerMode,
    agents,
    tasks: { prince: taskOf("c-prince-research"), mira: taskOf("d-handoff-mira") },
    purchases: activity.body.purchases as Parameters<typeof evaluateDemoAcceptance>[0]["purchases"],
    receipts,
    merchantCredits: await merchantCredits(e, activity.body.purchases as Array<Parameters<typeof merchantSignatures>[0]>),
  });
  writeJson(join(dir, "inference-receipts.json"), {
    provider: e.providerMode === "live" ? "OpenRouter (operator-funded real inference, bounded per pinned tariff)" : "FIXTURE mock provider (local rehearsal; not real inference)",
    note: "Prompts and inputs are not recorded here; outputs are saved as artifacts.",
    receipts,
  });
  writeJson(join(dir, "ledger.json"), {
    note: "Redacted owner ledger: purchases, states, amounts and public signatures. No credentials, keys or note secrets.",
    balances: balances.body,
    purchases,
    tasks: (tasks.body.tasks as Array<Record<string, unknown>>).map((t) => ({ id: t.id, agentId: t.agentId, objective: t.objective, state: t.state, used: t.used, limits: t.limits })),
    artifacts: items.map((a) => ({ id: a.id, kind: a.kind, title: a.title })),
  });
  writeJson(join(dir, "summary.json"), {
    kind: "Veilo demo:run evidence",
    runId: s.runId,
    profile: s.profile,
    network: e.providerMode === "live" ? "Solana devnet (test USDC; no monetary value)" : "LOCAL TEST VALIDATOR (not devnet)",
    program: e.manifest.program.programId,
    poolState: e.manifest.pool.poolState,
    poolExplorer: s.profile === "devnet" ? explorerAddress(e.manifest.pool.poolState) : null,
    owner: e.owner.address,
    labels: {
      inference: e.providerMode === "live" ? "operator-funded commercial inference via OpenRouter" : "FIXTURE provider (not real inference)",
      data: "research datasets are labeled demo fixture data (CC0)",
      payments: "test-chain x402 payments in test USDC",
      credits: "Demo inference credits — backed by the operator's OpenRouter account",
      privacy: "Deposits, payouts, amounts, fresh wallets and timing are public; the hidden property is which deposit funded a withdrawal. The demo owner is the only depositor in this run, so its anonymity set is small.",
    },
    acceptance,
    steps: s.steps,
    deposits: s.deposits.map((d) => ({ ...d, explorer: d.signature ? e.explorer(d.signature) : null })),
    approvals: s.approvals.map((a) => ({ signature: a, explorer: e.explorer(a) })),
    exit: s.exit ? { ...s.exit, explorer: e.explorer(s.exit.signature) } : null,
    files: ["summary.json", "ledger.json", "inference-receipts.json", "artifacts/"],
  });
  copyFileSync(STATE_PATH, join(dir, "run-state.json"));
  const hits = scanDir(dir, e.secrets);
  if (hits.length > 0) throw new Error(`evidence secret scan failed:\n  ${hits.join("\n  ")}`);
  log(`evidence: ${relative(rootDir, dir)} (secret scan clean over ${e.secrets.length} known secret values)`);
  log("acceptance:");
  for (const c of acceptance.checks) log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
  return acceptance;
}

// ---------------------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Veilo demo:run — ${LOCAL ? "LOCAL REHEARSAL (loopback test validator, throwaway keys, FIXTURE provider)" : execute ? "DEVNET EXECUTE (signing enabled, real inference)" : "DEVNET DRY RUN (read-only; nothing is signed; no OpenRouter call)"}`);
  if (LOCAL) {
    STATE_PATH = join(rootDir, "work", "demo-rehearsal-state.json");
    const s = hasFlag("--resume") ? loadState(STATE_PATH, "local-rehearsal") : loadState(join(rootDir, "work", "demo-rehearsal", "no-state"), "local-rehearsal");
    saveState(s);
    printPlan();
    log("\nreal-demo gate: BLOCKED in this mode by design (FIXTURE provider; fixture output does not pass real-inference acceptance)");
    const { env } = await localEnv(s);
    let acceptance: AcceptanceResult;
    try {
      acceptance = await writeEvidence(env, s, await run(env, s));
    } finally {
      await env.stop();
    }
    if (!acceptance.passed) throw new Error(`local rehearsal ${s.runId} finished, but acceptance checks failed (see above and ${relative(rootDir, env.evidenceDir)}/summary.json)`);
    log(`\nLocal rehearsal complete (run ${s.runId}).`);
    return;
  }
  const r = await devnetReadiness();
  printPlan();
  if (!r.ok) {
    log(`\nNOT READY:\n  - ${r.problems.join("\n  - ")}`);
    if (execute) throw new Error("readiness checks failed; nothing was signed");
  } else log("\nreadiness: all checks passed (pool, gateway merchant, facilitator, provider configuration, allowances, balances, budget)");
  if (!execute) {
    log("\nDRY RUN complete: nothing was signed or sent and no provider was called. Execute with: pnpm demo:run -- --execute --confirm");
    if (!r.ok) process.exitCode = 1;
    return;
  }
  mkdirSync(join(rootDir, "work", "demo"), { recursive: true });
  STATE_PATH = join(rootDir, "work", "demo", "devnet-state.json");
  const s = loadState(STATE_PATH, "devnet");
  saveState(s);
  log(`\nrun ${s.runId} (state ${relative(rootDir, STATE_PATH)})`);
  const env = await devnetEnv(r, s);
  let acceptance: AcceptanceResult;
  try {
    acceptance = await writeEvidence(env, s, await run(env, s));
  } finally {
    await env.stop();
  }
  if (!acceptance.passed) throw new Error(`demo run ${s.runId} finished, but acceptance checks failed; the evidence in ${relative(rootDir, env.evidenceDir)} records which. Rerunning resumes the same run and only re-checks`);
  log(`\nDemo run ${s.runId} complete. Evidence: ${relative(rootDir, env.evidenceDir)}`);
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    console.error(`\ndemo:run stopped: ${(error as Error).message}`);
    console.error("State is kept; rerun the same command to resume from the last completed step.");
    process.exit(1);
  },
);

