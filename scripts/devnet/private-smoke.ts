// M2 private-payment gate on devnet, driven through the real wallet and relayer modules
// (in-process): two labeled deposits from two synthetic test participants → insert crank →
// approve-root → wallet spend with a real Groth16 proof funding a fresh payer through the
// relayer → change insertion → the fresh payer pays an ordinary x402 merchant (PayAI Echo,
// 10,000 base units) → public exit of one original note and of the change note.
//
//   pnpm demo:private-smoke                       read-only plan and readiness checks
//   pnpm demo:private-smoke -- --execute --confirm
//
// Each step is resumable: wallet state lives in an encrypted smoke wallet under
// work/devnet-smoke/ (gitignored), signatures are persisted before sending, and a rerun
// reconciles from chain evidence. Evidence: artifacts/evidence/m2-*.json.
//
// Off-chain authority: the control service is not part of this gate. The operator's explicit
// --execute --confirm stands in for control's prepare/release/sign stages ("smoke authority"),
// and this is recorded in the evidence. Proof verification, nullifiers, roots and the vault
// are the deployed program's.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import type { VerificationKey } from "snarkjs";
import { join, relative } from "node:path";
import {
  address,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  partiallySignTransaction,
  signature as toSignature,
  type KeyPairSigner,
  type SignatureBytes,
} from "@solana/kit";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";
import { findRepoRoot, loadConfig, loadDotEnv, redactUrl, type FundingBinding } from "@veilo/contracts";
import { checkFacilitatorSupport, decodeWireTransaction, deriveAta, fetchFacilitatorSupported, preparePayment, verifyPaymentRequired } from "@veilo/x402-client";
import { openSecretsDatabase } from "../../packages/db/src/index";
import {
  assertManifestMatches,
  buildApprovedTree,
  getPoseidon,
  parseDeploymentManifest,
  pendingDepositPda,
  seenPrecommitmentPda,
  toBe32,
  updateApprovedRootInstruction,
  type CircuitWitness,
  type DeploymentManifest,
  type GeneratedProof,
} from "../../packages/privacy-sdk/src/index";
import { ServiceCallError, createRpcChainPort, SnarkjsProver } from "../../services/wallet/src/adapters";
import type { MerchantSigner, WalletDeps } from "../../services/wallet/src/deps";
import { FundingService } from "../../services/wallet/src/funding";
import { NoteService } from "../../services/wallet/src/notes";
import { OwnerFlows } from "../../services/wallet/src/owner-flows";
import { poolContextFrom } from "../../services/wallet/src/pool";
import { PortUnavailableError, type ControlPort, type ControlPurchase, type RelayerPort } from "../../services/wallet/src/ports";
import { ensureOwnerServiceSecret, WalletKeys } from "../../services/wallet/src/secret";
import { WalletStore } from "../../services/wallet/src/store";
import { applyApprovalRule } from "../../services/relayer/src/cli/approve-root";
import { createRpcRelayerChain } from "../../services/relayer/src/chain";
import { InsertCrank } from "../../services/relayer/src/crank";
import { openRelayerDb, sponsorTotals } from "../../services/relayer/src/db";
import { verifyDeployment } from "../../services/relayer/src/deployment";
import { Indexer, readApprovedLabels } from "../../services/relayer/src/indexer";
import { loadSponsorKey } from "../../services/relayer/src/sponsor";
import { SwapService } from "../../services/relayer/src/swaps";
import { RelayerError, RecoveryService, WithdrawalService } from "../../services/relayer/src/withdrawals";
import {
  ata,
  awaitTx,
  checkRoleFiles,
  computeUnitLimitIx,
  decodeTokenAccount,
  acquireRunLock,
  EVIDENCE_DIR,
  PROFILE,
  SMOKE_DIR,
  verifyNetwork,
  executeMode,
  explorerAddress,
  explorerTx,
  finalizedOutcome,
  getAccount,
  lamportsOf,
  makeRpc,
  readJsonOr,
  readRoles,
  repoPath,
  roleSigner,
  sendWire,
  signAndSend,
  sleep,
  sol,
  usdc,
  writeJson,
  type RolesFile,
  type SentTx,
} from "./lib";

const ECHO_URL = "https://x402.payai.network/api/solana-devnet/paid-content";
const ECHO_MERCHANT = "8sqyMHQwBh8BCXC99pdgt6BpXwLu9xqfL1hDV5SFYf3R";
const PAYOUT = 10_000n;
const DEPOSIT_AMOUNT = 200_000n;
const SPONSOR_CAP_PER_WITHDRAWAL = 3_000_000n;
const OWNERS = ["testOwnerA", "testOwnerB"] as const;
const STOP_POINTS = ["deposits", "inserts", "approve-root", "release", "spend", "change-insert", "merchant"] as const;
type StopPoint = (typeof STOP_POINTS)[number];
/** --stop-after <step>: end the run after that step (state is kept; a rerun continues). */
const STOP_AFTER = ((): StopPoint | null => {
  const i = process.argv.indexOf("--stop-after");
  if (i < 0) return null;
  const v = process.argv[i + 1] as StopPoint | undefined;
  if (!v || !STOP_POINTS.includes(v)) throw new Error(`--stop-after expects one of: ${STOP_POINTS.join(", ")}`);
  return v;
})();
/** Wallet note states at or beyond insertion / approval. */
const INSERTED = new Set(["indexed", "approved", "spendable", "reserved", "spent", "exit_prepared", "exited"]);
const APPROVED = new Set(["spendable", "reserved", "spent", "exit_prepared", "exited"]);
type OwnerRole = (typeof OWNERS)[number];

const STATE_PATH = join(SMOKE_DIR, "state.json");

const rootDir = findRepoRoot();
loadDotEnv({ rootDir });
const config = loadConfig(process.env, { rootDir });
const rpc = makeRpc(config.network.rpcUrl);
const execute = executeMode();
const mint = address(config.network.mint);

class Stop extends Error {
  override readonly name = "Stop";
}
function stop(msg: string): never {
  throw new Stop(msg);
}

// ---------------------------------------------------------------------------------------
// Persistent smoke state (public data only: ids, signatures, addresses)

interface WireTxRecord extends SentTx {
  id: string;
}

interface SmokeState {
  schema: "veilo-m2-smoke-v1";
  poolState: string;
  stage: "none" | "prepare" | "release" | "merchant";
  deposits: Partial<Record<OwnerRole, WireTxRecord & { noteId: string }>>;
  approveRoot: SentTx | null;
  purchaseId: string | null;
  operationId: string | null;
  merchant: { signature: string | null; httpStatus: number | null; messageHash: string | null } | null;
  exits: Partial<Record<"original" | "change", WireTxRecord & { noteId: string; owner: OwnerRole }>>;
  proofTimings: Array<{ circuit: string; ms: number; at: string }>;
  /** The smoke's logical funding operation; each attempt has its own purchase/operation reference. */
  logicalOperationId?: string;
  attempts?: SmokeAttempt[];
}

interface SmokeAttempt {
  purchaseId: string;
  operationId: string;
  startedAt: string;
  outcome: "finalized" | "expired_unsettled" | null;
}

/** Attempt list, created from a single earlier purchase when the state predates attempts. */
function attemptsOf(s: SmokeState): SmokeAttempt[] {
  if (!s.attempts) {
    s.attempts = s.purchaseId ? [{ purchaseId: s.purchaseId, operationId: s.operationId!, startedAt: new Date().toISOString(), outcome: null }] : [];
    if (s.logicalOperationId === undefined && s.operationId) s.logicalOperationId = s.operationId;
  }
  return s.attempts;
}

const freshState = (pool: string): SmokeState => ({
  schema: "veilo-m2-smoke-v1",
  poolState: pool,
  stage: "none",
  deposits: {},
  approveRoot: null,
  purchaseId: null,
  operationId: null,
  merchant: null,
  exits: {},
  proofTimings: [],
});

function loadState(pool: string): SmokeState {
  const s = readJsonOr<SmokeState | null>(STATE_PATH, null);
  if (!s) return freshState(pool);
  if (s.poolState !== pool) stop(`${relative(rootDir, STATE_PATH)} belongs to pool ${s.poolState}, not ${pool}; move work/devnet-smoke aside to start over`);
  return s;
}
const saveState = (s: SmokeState) => writeJson(STATE_PATH, s);
const evidence = (name: string, body: Record<string, unknown>) => {
  const path = join(EVIDENCE_DIR, `m2-${name}.json`);
  writeJson(path, { kind: `M2 devnet private smoke: ${name}`, profile: PROFILE, network: config.network.caip2, recordedAt: new Date().toISOString(), ...body });
  console.log(`  evidence → ${relative(rootDir, path)}`);
};

// ---------------------------------------------------------------------------------------
// In-process ports

/** Operator-confirmed authority stages for this smoke (see header). Nothing is reserved in control. */
class SmokeAuthority implements ControlPort {
  constructor(private readonly s: SmokeState) {}
  async purchase(id: string): Promise<ControlPurchase> {
    const stage = this.s.stage;
    return {
      id,
      operationId: attemptsOf(this.s).find((a) => a.purchaseId === id)?.operationId ?? this.s.operationId ?? "",
      agentId: "m2-smoke",
      paymentPath: "direct_x402",
      price: { amount: PAYOUT.toString() },
      feeCap: { amount: "0" },
      sponsorReservation: { amount: SPONSOR_CAP_PER_WITHDRAWAL.toString() },
      states: {
        authorization: stage === "prepare" ? "reserved" : "released",
        funding: stage === "prepare" ? "proof_prepared" : stage === "release" ? "proof_released" : "finalized",
        merchant: stage === "merchant" ? "signed" : "none",
        fulfilment: "none",
        recovery: "none",
      },
      reservation: { status: "active" },
      epochs: { agent: 0, stop: 0 },
    };
  }
  async ownerSession(): Promise<never> {
    throw new Error("owner sessions are not used by the smoke");
  }
  async registerDepositNote() {}
  async confirmChange() {}
  async noteExited() {}
  async merchantExpired(id: string) {
    return this.purchase(id);
  }
  async swapNotSigned(id: string) {
    return this.purchase(id);
  }
  async markRecoverable(id: string) {
    return this.purchase(id);
  }
  async recordRecovery() {}
  async livePurchases() {
    return [];
  }
  async notes() {
    return [];
  }
}

const relayerCall = async <T>(fn: () => Promise<T> | T): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof RelayerError) throw new ServiceCallError(error.status, error.code, `relayer: ${error.message}`);
    // Anything else (for example an RPC 429 inside the relayer) is what an HTTP client sees as an
    // unreachable relayer: the wallet records the outcome as uncertain and reconciles it.
    throw new PortUnavailableError(`relayer call failed (${(error as Error).name}: ${(error as Error).message})`);
  }
};

function echoMerchantSigner(): MerchantSigner {
  return {
    async sign({ paymentRequired, binding, exactAmount, purchaseRef, wallet }) {
      // PayAI Echo declares no Veilo gateway identity or SKU tags; every other binding field is enforced.
      const prepared = await preparePayment({
        paymentRequired: paymentRequired as PaymentRequired,
        binding: { origin: binding.origin, network: binding.network, mint: binding.mint, payTo: binding.payTo, merchantAta: binding.merchantAta, maxAmount: exactAmount, exactAmount, allowedFeePayers: binding.allowedFeePayers },
        wallet: { address: wallet.address, signPaymentMessage: async (r) => (await wallet.signPaymentMessage(r)) as SignatureBytes },
        purchaseRef,
        rpcUrl: config.network.rpcUrl,
      });
      const header = prepared.headers["PAYMENT-SIGNATURE"] ?? Object.values(prepared.headers)[0];
      if (!header) throw new Error("x402 client produced no payment header");
      return { paymentSignatureHeader: header, messageHash: prepared.validated.messageHash, recentBlockhash: prepared.validated.recentBlockhash };
    },
  };
}

async function fetchEchoChallenge(): Promise<PaymentRequired> {
  const res = await fetch(ECHO_URL, { redirect: "error" });
  if (res.status !== 402) stop(`expected HTTP 402 from the Echo merchant, got ${res.status}`);
  const text = await res.text();
  return new x402HTTPClient(new x402Client()).getPaymentRequiredResponse((n) => res.headers.get(n), text ? (JSON.parse(text) as unknown) : undefined);
}

async function echoBinding(feePayers: string[]): Promise<FundingBinding> {
  return {
    origin: new URL(ECHO_URL).origin,
    gatewayIdentity: "payai-echo-merchant",
    sku: "paid-content",
    network: config.network.caip2,
    mint,
    payTo: ECHO_MERCHANT,
    merchantAta: await deriveAta(ECHO_MERCHANT, mint),
    allowedFeePayers: feePayers,
  };
}

// ---------------------------------------------------------------------------------------

interface World {
  roles: RolesFile;
  manifest: DeploymentManifest;
  state: SmokeState;
  deps: WalletDeps;
  notes: NoteService;
  funding: FundingService;
  owner: OwnerFlows;
  indexer: Indexer;
  crank: InsertCrank;
  withdrawals: WithdrawalService;
  relayerDb: ReturnType<typeof openRelayerDb>;
  labelsPath: string;
  feePayers: string[];
  close(): void;
}

async function buildWorld(roles: RolesFile, manifest: DeploymentManifest, feePayers: string[]): Promise<World> {
  mkdirSync(SMOKE_DIR, { recursive: true });
  const state = loadState(manifest.pool.poolState);
  const secretPath = join(SMOKE_DIR, "owner-service.secret");
  if (execute) ensureOwnerServiceSecret(secretPath);
  else if (!existsSync(secretPath)) stop("internal: world is built only in execute mode or after a first execute");
  const keys = WalletKeys.fromFile(secretPath);
  const walletDb = openSecretsDatabase(join(SMOKE_DIR, "wallet-secrets.sqlite"), { controlDatabasePath: config.paths.controlDatabase });
  const store = new WalletStore(walletDb, keys);
  const relayerDb = openRelayerDb(join(SMOKE_DIR, "relayer.sqlite"));
  const chain = createRpcRelayerChain(config.network.rpcUrl);
  const poseidon = await getPoseidon();
  const labelsPath = repoPath(process.env.APPROVED_LABELS_PATH?.trim() || "artifacts/deployment/approved-labels.json");
  const programId = address(manifest.program.programId);
  const indexer = new Indexer(relayerDb, chain, poseidon, programId, address(manifest.pool.poolState), address(manifest.pool.approvalState), labelsPath);
  const sponsor = await loadSponsorKey(repoPath(roles.roles.sponsor.keyPath));
  if (!sponsor || sponsor.address !== manifest.authorities.sponsor) stop("sponsor key does not match the manifest sponsor/relayer");
  const prover = new SnarkjsProver(rootDir);
  if (!prover.available()) stop("circuits/build proving files missing; run pnpm test:circuits (deterministic, hash-checked)");
  const timed = (circuit: string, fn: () => Promise<GeneratedProof>) => async () => {
    const t0 = performance.now();
    const r = await fn();
    state.proofTimings.push({ circuit, ms: Math.round(performance.now() - t0), at: new Date().toISOString() });
    saveState(state);
    return r;
  };
  const ctx = { db: relayerDb, chain, sponsor, manifest: () => manifest, spendVk: JSON.parse(readFileSync(join(rootDir, "artifacts", "circuits", "spend.vkey.json"), "utf8")) as VerificationKey, sponsorCapLamports: BigInt(process.env.RELAYER_SPONSOR_LAMPORT_CAP?.trim() || "100000000") };
  const withdrawals = new WithdrawalService(ctx);
  const recoveries = new RecoveryService(ctx);
  const swaps = new SwapService(ctx);
  const crank = new InsertCrank({
    db: relayerDb,
    chain,
    indexer,
    poseidon,
    sponsor,
    manifest: () => manifest,
    prover: { prove: (w: CircuitWitness) => timed("insert", () => prover.prove("insert", w))() },
    sponsorCapLamports: ctx.sponsorCapLamports,
  });
  const relayer: RelayerPort = {
    deployment: async () => manifest,
    publicState: () => relayerCall(async () => (await indexer.replay()).view),
    submitWithdrawal: (req) => relayerCall(() => withdrawals.submit(req)),
    withdrawal: (id) => relayerCall(() => withdrawals.view(id)),
    submitRecovery: (req) => relayerCall(() => recoveries.submit(req)),
    recovery: (id) => relayerCall(() => recoveries.view(id)),
    submitSwap: (req) => relayerCall(() => swaps.submit(req)),
    swap: (id) => relayerCall(() => swaps.view(id)),
  };
  const deps: WalletDeps = {
    store,
    poseidon,
    control: new SmokeAuthority(state),
    relayer,
    chain: createRpcChainPort(config.network.rpcUrl),
    prover: { prove: (c, w) => timed(c, () => prover.prove(c, w))() },
    merchant: echoMerchantSigner(),
    pool: async () => poolContextFrom(manifest),
    ownerRecoveryAddress: null,
  };
  const funding = new FundingService(deps);
  return {
    roles,
    manifest,
    state,
    deps,
    notes: new NoteService(deps),
    funding,
    owner: new OwnerFlows(deps, funding),
    indexer,
    crank,
    withdrawals,
    relayerDb,
    labelsPath,
    feePayers,
    close: () => {
      walletDb.close();
      relayerDb.close();
    },
  };
}

async function txDetails(sig: string): Promise<Record<string, unknown>> {
  const tx = await rpc.getTransaction(toSignature(sig), { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 }).send();
  if (!tx) return { signature: sig, finalized: false };
  const keys = tx.transaction.message.accountKeys.map(String);
  const pre = tx.meta?.preBalances ?? [];
  const post = tx.meta?.postBalances ?? [];
  return {
    signature: sig,
    explorer: explorerTx(sig),
    slot: tx.slot.toString(),
    err: tx.meta?.err ?? null,
    feeLamports: (tx.meta?.fee ?? 0n).toString(),
    computeUnitsConsumed: tx.meta?.computeUnitsConsumed?.toString() ?? null,
    lamportChanges: keys.map((k, i) => ({ account: k, delta: (BigInt(post[i] ?? 0n) - BigInt(pre[i] ?? 0n)).toString() })).filter((c) => c.delta !== "0"),
    accountKeys: keys,
  };
}

/** Signs an unsigned wallet-built wire transaction with the owner's key. */
async function ownerSign(wire: string, owner: KeyPairSigner): Promise<{ wire: string; signature: string }> {
  const tx = await partiallySignTransaction([owner.keyPair], decodeWireTransaction(wire));
  return { wire: getBase64EncodedWireTransaction(tx), signature: getSignatureFromTransaction(tx) };
}

async function waitFor(what: string, fn: () => Promise<boolean>, timeoutMs = 240_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) stop(`${what}: not reached within ${Math.round(timeoutMs / 1000)} s; rerun to resume (state is persisted)`);
    await sleep(4_000);
  }
}

// ---------------------------------------------------------------------------------------
// Steps

async function stepDeposits(w: World): Promise<void> {
  const rows: Record<string, unknown>[] = [];
  for (const role of OWNERS) {
    const owner = await roleSigner(w.roles, role);
    let rec = w.state.deposits[role];
    if (rec) {
      const dep = w.deps.store.deposit(rec.id);
      if (dep?.state === "finalized") {
        rows.push({ role, owner: owner.address, depositId: rec.id, ...(await txDetails(rec.signature)) });
        continue;
      }
      const r = await awaitTx(rpc, rec);
      if (r.state === "pending") stop(`deposit ${role}: ${rec.signature} not finalized yet; rerun later`);
      if (r.state === "expired") {
        await w.notes.sync();
        delete w.state.deposits[role];
        saveState(w.state);
        rec = undefined;
      }
    }
    if (!rec) {
      const prepared = await w.notes.prepareDeposit(owner.address, DEPOSIT_AMOUNT);
      const signed = await ownerSign(prepared.transaction, owner);
      const noteId = w.deps.store.deposit(prepared.depositId)!.note_id;
      rec = { id: prepared.depositId, noteId, signature: signed.signature, lastValidBlockHeight: prepared.lastValidBlockHeight, sentAt: new Date().toISOString() };
      w.notes.registerDeposit(owner.address, prepared.depositId, signed.signature);
      w.state.deposits[role] = rec;
      saveState(w.state);
      await sendWire(rpc, signed.wire).catch((e: Error) => console.log(`  deposit ${role}: send reported ${e.message}; reconciling by signature`));
      console.log(`  deposit ${role}: sent ${signed.signature}`);
      const r = await awaitTx(rpc, rec);
      if (r.state !== "finalized" || r.outcome.err !== null) stop(`deposit ${role}: ${r.state === "finalized" ? `failed ${JSON.stringify(r.outcome.err)}` : r.state}; rerun to reconcile`);
    }
    await waitFor(`deposit ${role} indexed`, async () => {
      await w.notes.sync();
      return w.deps.store.deposit(rec!.id)?.state === "finalized";
    });
    rows.push({ role, owner: owner.address, depositId: rec.id, amount: DEPOSIT_AMOUNT.toString(), ...(await txDetails(rec.signature)) });
    console.log(`  deposit ${role}: finalized (${explorerTx(rec.signature)})`);
  }
  evidence("deposits", {
    participants: "synthetic/test participants (role-separated keys funded by the operator; not independent users)",
    amountEach: DEPOSIT_AMOUNT.toString(),
    deposits: rows,
    privacyNote: "Deposit amount, source and timing are public. Two equal-amount deposits from two synthetic participants form a tiny anonymity set.",
  });
}

/** Drives the insert crank until the queue is empty; returns every crank attempt recorded so far. */
async function crankUntilIdle(w: World, label: string): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + 600_000;
  for (;;) {
    const r = await w.crank.step();
    if (r === "idle") break;
    if (r === "not_ready" || r === "sponsor_cap") stop(`${label}: insert crank ${r}`);
    if (r === "insert" || r === "skip") console.log(`  ${label}: crank submitted ${r}`);
    if (Date.now() > deadline) stop(`${label}: crank did not drain the queue in time; rerun to resume`);
    await sleep(r === "waiting" ? 4_000 : 1_000);
  }
  const rows = w.relayerDb.prepare(`SELECT queue_seq, kind, signature, state FROM crank_attempt ORDER BY created_at_ms`).all() as Array<{ queue_seq: bigint; kind: string; signature: string; state: string }>;
  const out: Record<string, unknown>[] = [];
  for (const row of rows) out.push({ queueSeq: row.queue_seq.toString(), kind: row.kind, state: row.state, ...(row.state === "finalized" ? await txDetails(row.signature) : { signature: row.signature }) });
  return out;
}

async function stepInsertDeposits(w: World): Promise<void> {
  const inserts = await crankUntilIdle(w, "insert deposits");
  await w.notes.sync();
  const { view } = await w.indexer.replay();
  evidence("inserts", { leaves: view.leaves, currentRoot: view.pool.currentRoot, crankAttempts: inserts, proofTimingsMs: w.state.proofTimings.filter((t) => t.circuit === "insert") });
}

async function stepApproveRoot(w: World): Promise<void> {
  const p = w.deps.poseidon;
  const participants = new Set(OWNERS.map((r) => w.roles.roles[r].publicKey));
  if (w.state.approveRoot) {
    const r = await awaitTx(rpc, w.state.approveRoot);
    if (r.state === "pending") stop("approve-root transaction not finalized yet; rerun later");
    if (r.state === "finalized" && r.outcome.err !== null) stop(`approve-root failed on chain: ${JSON.stringify(r.outcome.err)}`);
    if (r.state === "expired") w.state.approveRoot = null;
  }
  const { replay } = await w.indexer.replay();
  const previous = (readApprovedLabels(w.labelsPath, w.manifest.pool.poolState)?.labels ?? []).map(BigInt);
  const labels = applyApprovalRule(replay, participants, previous);
  const root = buildApprovedTree(p, labels).root;
  if (root !== replay.approvedRoot) {
    writeJson(w.labelsPath, { schema: "veilo-approved-labels-v1", pool: w.manifest.pool.poolState, rule: "operator approves labels of finalized, inserted deposits made by the configured synthetic/test participants; no sanctions or compliance screening", labels: labels.map(String), root: root.toString() });
    const signer = await roleSigner(w.roles, "approvalAuthority");
    const ix = updateApprovedRootInstruction(address(w.manifest.program.programId), { approvalAuthority: signer.address, poolState: address(w.manifest.pool.poolState), approvalState: address(w.manifest.pool.approvalState) }, root);
    const sent = await signAndSend(rpc, signer, [], [computeUnitLimitIx(100_000), ix], (s) => {
      w.state.approveRoot = s;
      saveState(w.state);
    });
    console.log(`  approve-root: sent ${sent.signature}`);
    const r = await awaitTx(rpc, sent);
    if (r.state !== "finalized" || r.outcome.err !== null) stop(`approve-root: ${r.state}; rerun to reconcile`);
  }
  await waitFor("approved labels visible to the wallet", async () => {
    await w.notes.sync();
    return OWNERS.every((o) => APPROVED.has(w.deps.store.note(w.state.deposits[o]!.noteId)?.state ?? ""));
  });
  evidence("approve-root", {
    rule: "labels of finalized, inserted deposits by configured synthetic/test participants (published prototype rule; no screening)",
    approvedLabels: labels.length,
    approvedRoot: root.toString(),
    labelsFile: relative(rootDir, w.labelsPath).split("\\").join("/"),
    transaction: w.state.approveRoot ? await txDetails(w.state.approveRoot.signature) : "not needed (root already current)",
  });
}

async function stepSpend(w: World): Promise<void> {
  const s = w.state;
  const inputNoteId = s.deposits.testOwnerA!.noteId;
  const live = w.deps.store.fundings().find((x) => x.input_note_id === inputNoteId && x.step !== "discarded" && x.step !== "expired_unsettled");
  if (live && s.purchaseId !== live.purchase_id) {
    // The wallet database is authoritative: adopt its funding instead of proving a second spend of the note.
    console.log(`  spend: adopting the wallet's existing funding ${live.purchase_id} (${live.step})`);
    s.purchaseId = live.purchase_id;
    s.operationId = live.operation_id;
    s.stage = live.step === "prepared" ? "prepare" : "release";
    if (!attemptsOf(s).some((a) => a.purchaseId === live.purchase_id)) s.attempts!.push({ purchaseId: live.purchase_id, operationId: live.operation_id, startedAt: new Date().toISOString(), outcome: null });
    saveState(s);
  }
  if (!s.purchaseId) {
    s.purchaseId = randomUUID();
    s.operationId = `m2-smoke-${s.purchaseId}`;
    s.logicalOperationId = s.operationId;
    s.stage = "prepare";
    s.attempts = [{ purchaseId: s.purchaseId, operationId: s.operationId, startedAt: new Date().toISOString(), outcome: null }];
    saveState(s);
  }
  attemptsOf(s);
  let f = w.deps.store.funding(s.purchaseId);
  if (f?.step === "expired_unsettled") {
    // The wallet proved this attempt unsettled (bound passed, nullifier unused). Its proof and
    // fresh wallet are never reused; a new attempt of the same logical operation starts here.
    const prior = s.attempts!.find((a) => a.purchaseId === s.purchaseId)!;
    prior.outcome = "expired_unsettled";
    const n = s.attempts!.length + 1;
    s.purchaseId = randomUUID();
    s.operationId = `${s.logicalOperationId}:attempt-${n}`;
    s.stage = "prepare";
    s.attempts!.push({ purchaseId: s.purchaseId, operationId: s.operationId, startedAt: new Date().toISOString(), outcome: null });
    saveState(s);
    console.log(`  spend: attempt ${n - 1} (${prior.purchaseId}) expired unsettled; starting attempt ${n} with a new proof and fresh payer`);
    f = undefined;
  }
  const pid = s.purchaseId;
  if (!f) {
    const pr = await fetchEchoChallenge();
    const binding = await echoBinding(w.feePayers);
    const verified = await verifyPaymentRequired(pr, { origin: binding.origin, network: binding.network, mint: binding.mint, payTo: binding.payTo, merchantAta: binding.merchantAta, maxAmount: PAYOUT, exactAmount: PAYOUT, allowedFeePayers: binding.allowedFeePayers });
    if (verified.amount !== PAYOUT) stop(`Echo now charges ${verified.amount}, expected ${PAYOUT}`);
    const input = w.deps.store.note(inputNoteId)!;
    const req = {
      purchaseId: pid,
      operationId: s.operationId!,
      payoutUsdc: PAYOUT,
      tokenFeeCapUsdc: 0n,
      sponsorLamportCap: SPONSOR_CAP_PER_WITHDRAWAL,
      inputNote: { commitment: input.commitment, value: input.value },
      binding,
    };
    const prior = s.attempts!.length > 1 ? s.attempts![s.attempts!.length - 2]! : null;
    const r = prior ? await w.funding.reattemptAfterExpiry(prior.purchaseId, req) : await w.funding.prepare(req);
    if (r.status !== "prepared") stop(`funding ${prior ? "re-attempt" : "prepare"}: ${r.status} ${"reason" in r ? r.reason : ""}`);
    console.log(`  spend: proof prepared (attempt ${s.attempts!.length}, fresh payer ${r.payer})`);
    f = w.deps.store.funding(pid)!;
  }
  if (f.step === "prepared") {
    s.stage = "release";
    saveState(s);
    const r = await w.funding.release(pid, pid);
    console.log(`  spend: proof released to the relayer (${r.status}${"reason" in r ? `: ${r.reason}` : ""})`);
  }
  if (STOP_AFTER === "release") {
    console.log("\nstopped after \"release\" as requested (--stop-after); rerun without it to continue");
    process.exit(0);
  }
  const wid = w.deps.store.funding(pid)!.relayer_withdrawal_id!;
  let lastReport = 0;
  const report = (msg: string) => {
    if (Date.now() - lastReport < 20_000) return;
    lastReport = Date.now();
    console.log(`  spend: ${msg}`);
  };
  await waitFor("withdrawal finalized", async () => {
    const fr = w.deps.store.funding(pid)!;
    const v = w.withdrawals.view(wid);
    if (v === null) {
      const slot = await rpc.getSlot({ commitment: "finalized" }).send();
      report(`relayer has no record of withdrawal ${wid} (finalized slot ${slot}, proof bound ${fr.valid_until_slot}); the wallet resends the same proof while the bound allows`);
    } else {
      await w.withdrawals.advance(wid).catch((e: Error) => report(`relayer advance: ${e.name}: ${e.message}`));
      const now = w.withdrawals.view(wid)!;
      if (now.state !== "finalized") report(`relayer withdrawal ${now.state}${now.error ? ` (${now.error})` : ""}${now.signature ? `, signature ${now.signature}` : ""}`);
    }
    const st = await w.funding.status(pid);
    if (st.status === "expired_unsettled") {
      stop(`attempt ${s.attempts!.length} (${pid}) expired unsettled: ${st.reason}. Nothing settled and the note is unspent; rerun the same command to start a new attempt with a new proof and fresh payer`);
    }
    if (st.status === "uncertain" || st.status === "not_ready" || st.status === "recovery_required") report(`wallet funding ${st.status}: ${st.reason}`);
    return st.status === "finalized";
  }, 360_000);
  s.attempts!.find((a) => a.purchaseId === pid)!.outcome = "finalized";
  saveState(s);
  const v = w.withdrawals.view(wid)!;
  const fr = w.deps.store.funding(pid)!;
  const spendTx = await txDetails(v.signature!);
  // PRIV-07: the withdrawal must not reference any deposit's accounts, owner or note fields.
  const pool = address(w.manifest.pool.poolState);
  const program = address(w.manifest.program.programId);
  const { replay } = await w.indexer.replay();
  const forbidden: string[] = [];
  const fieldBytes: Array<{ queueSeq: string; bytes: Buffer }> = [];
  for (const d of replay.deposits.values()) {
    forbidden.push(d.refundAuthority, await ata(d.refundAuthority, mint), (await pendingDepositPda(program, pool, d.queueSeq)).address, (await seenPrecommitmentPda(program, pool, toBe32(d.precommitment))).address);
    for (const x of [toBe32(d.commitment), toBe32(d.label), toBe32(d.precommitment), d.salt]) fieldBytes.push({ queueSeq: d.queueSeq.toString(), bytes: Buffer.from(x) });
  }
  const keys = spendTx.accountKeys as string[];
  const linked = forbidden.filter((k) => keys.includes(k));
  const rawTx = await rpc.getTransaction(toSignature(v.signature!), { commitment: "finalized", encoding: "base64", maxSupportedTransactionVersion: 0 }).send();
  const txBytes = Buffer.from(rawTx!.transaction[0], "base64");
  const fieldLeaks = [...new Set(fieldBytes.filter((f) => txBytes.includes(f.bytes)).map((f) => f.queueSeq))];
  evidence("spend", {
    authority: "smoke authority: operator --execute --confirm stands in for control's prepare/release stages (no control ledger reservation)",
    purchaseId: pid,
    logicalOperationId: s.logicalOperationId,
    attempts: s.attempts!.map((at) => {
      const row = w.deps.store.funding(at.purchaseId);
      return {
        ...at,
        walletStep: row?.step ?? null,
        freshPayer: row?.fresh_wallet ?? null,
        validUntilSlot: row?.valid_until_slot.toString() ?? null,
        relayerWithdrawalId: row?.relayer_withdrawal_id ?? null,
        relayerRecord: row?.relayer_withdrawal_id ? (w.withdrawals.view(row.relayer_withdrawal_id)?.state ?? "none") : "none",
      };
    }),
    freshPayer: fr.fresh_wallet,
    freshPayerExplorer: explorerAddress(fr.fresh_wallet),
    payout: PAYOUT.toString(),
    validUntilSlot: fr.valid_until_slot.toString(),
    nullifierHash: fr.nullifier_hash,
    ataTransaction: v.ataSignature ? await txDetails(v.ataSignature) : null,
    spendTransaction: spendTx,
    sponsorLamports: { fees: v.sponsorFeeLamports, rentOutstanding: v.sponsorRentLamports, relayerTotals: Object.fromEntries(Object.entries(sponsorTotals(w.relayerDb)).map(([k, x]) => [k, x.toString()])) },
    priv07: {
      check: "spend transaction account keys and bytes contain no deposit refund authority, its ATA, PendingDeposit/SeenPrecommitment PDA, deposit commitment, label, precommitment or salt",
      linkedAccounts: linked,
      depositFieldBytesFound: fieldLeaks,
      passed: linked.length === 0 && fieldLeaks.length === 0,
      caveat: "Amounts, timing, the fresh payer and the sponsor are public; with two synthetic participants the anonymity set is two at most.",
    },
    proofTimingsMs: w.state.proofTimings.filter((t) => t.circuit === "spend"),
  });
  if (linked.length > 0 || fieldLeaks.length > 0) stop("PRIV-07 check failed: the withdrawal references deposit identifiers");
}

async function stepInsertChange(w: World): Promise<void> {
  const inserts = await crankUntilIdle(w, "insert change");
  const f = w.deps.store.funding(w.state.purchaseId!)!;
  await waitFor("change note inserted", async () => {
    await w.notes.sync();
    return INSERTED.has(w.deps.store.note(f.change_note_id)?.state ?? "");
  });
  evidence("change-insert", { changeNoteState: w.deps.store.note(f.change_note_id)!.state, crankAttempts: inserts });
}

async function stepMerchant(w: World): Promise<void> {
  const s = w.state;
  const pid = s.purchaseId!;
  s.stage = "merchant";
  saveState(s);
  const f = w.deps.store.funding(pid)!;
  let outcome = await w.funding.merchantOutcome(pid);
  let httpStatus: number | null = s.merchant?.httpStatus ?? null;
  let responseExcerpt: string | null = null;
  if (outcome === "none" || outcome === "signed") {
    const prior = w.deps.store.merchantPayment(pid);
    let header = prior?.payment_header;
    if (!header) {
      const pr = await fetchEchoChallenge();
      const r = await w.funding.signMerchant(pid, { fundingRef: pid, paymentRequired: pr, binding: JSON.parse(f.binding_json) as FundingBinding, exactAmountUsdc: PAYOUT });
      if (r.status !== "signed") stop(`signMerchant: ${r.status} ${"reason" in r ? r.reason : ""}`);
      header = r.paymentSignatureHeader;
      s.merchant = { signature: null, httpStatus: null, messageHash: r.messageHash };
      saveState(s);
    }
    // Resending the same signed payment cannot pay twice: it is one transaction signature.
    const res = await fetch(ECHO_URL, { headers: { "PAYMENT-SIGNATURE": header }, redirect: "error" });
    httpStatus = res.status;
    responseExcerpt = (await res.text()).slice(0, 300);
    let settled: string | null;
    try {
      settled = new x402HTTPClient(new x402Client()).getPaymentSettleResponse((n) => res.headers.get(n)).transaction ?? null;
    } catch {
      settled = null;
    }
    s.merchant = { signature: settled, httpStatus, messageHash: w.deps.store.merchantPayment(pid)!.message_hash };
    saveState(s);
    console.log(`  merchant: Echo replied HTTP ${httpStatus}${settled ? `, settlement ${settled}` : ""}`);
    await waitFor("merchant payment finalized", async () => {
      outcome = await w.funding.merchantOutcome(pid);
      if (outcome === "expired_unsettled" || outcome === "failed") stop(`merchant payment ${outcome}; the fresh wallet holds the payout and is recoverable by the owner`);
      return outcome === "finalized";
    });
  }
  const mp = w.deps.store.merchantPayment(pid)!;
  const freshAta = await ata(mp.fresh_wallet, mint);
  const freshAcct = await getAccount(rpc, freshAta);
  evidence("merchant", {
    authority: "smoke authority: operator --execute --confirm stands in for control's sign_merchant stage",
    merchant: { url: ECHO_URL, payTo: ECHO_MERCHANT, kind: "PayAI Echo Merchant (devnet smoke merchant; it refunds payments)" },
    facilitator: config.network.facilitatorUrl,
    freshPayer: mp.fresh_wallet,
    amount: mp.amount.toString(),
    messageHash: mp.message_hash,
    httpStatus,
    responseExcerpt,
    settlement: mp.settlement_signature ? await txDetails(mp.settlement_signature) : null,
    freshPayerTokenBalanceAfter: freshAcct ? decodeTokenAccount(freshAcct.data).amount.toString() : null,
    note: "The fresh payer signed only the transfer; the facilitator paid the transaction fee. Any Echo refund lands in the fresh payer's ATA and is recoverable to the owner recovery address (not part of this gate).",
  });
}

async function stepExits(w: World): Promise<void> {
  const f = w.deps.store.funding(w.state.purchaseId!)!;
  const plan: Array<{ key: "original" | "change"; owner: OwnerRole; noteId: string }> = [
    { key: "original", owner: "testOwnerB", noteId: w.state.deposits.testOwnerB!.noteId },
    { key: "change", owner: "testOwnerA", noteId: f.change_note_id },
  ];
  const rows: Record<string, unknown>[] = [];
  for (const item of plan) {
    const owner = await roleSigner(w.roles, item.owner);
    let rec = w.state.exits[item.key];
    if (rec) {
      const r = await awaitTx(rpc, rec);
      if (r.state === "pending") stop(`exit ${item.key}: not finalized yet; rerun later`);
      if (r.state === "expired") {
        await w.notes.sync();
        delete w.state.exits[item.key];
        saveState(w.state);
        rec = undefined;
      } else if (r.outcome.err !== null) stop(`exit ${item.key} failed on chain: ${JSON.stringify(r.outcome.err)}`);
    }
    if (!rec) {
      const before = (await getAccount(rpc, await ata(owner.address, mint)))?.data;
      const prepared = (await w.owner.prepareExit(owner.address, item.noteId)) as { exitId: string; transaction: string; lastValidBlockHeight: string; value: { amount: string } };
      const signed = await ownerSign(prepared.transaction, owner);
      rec = { id: prepared.exitId, noteId: item.noteId, owner: item.owner, signature: signed.signature, lastValidBlockHeight: prepared.lastValidBlockHeight, sentAt: new Date().toISOString() };
      w.owner.registerExit(owner.address, prepared.exitId, signed.signature);
      w.state.exits[item.key] = rec;
      saveState(w.state);
      await sendWire(rpc, signed.wire).catch((e: Error) => console.log(`  exit ${item.key}: send reported ${e.message}; reconciling by signature`));
      console.log(`  exit ${item.key}: sent ${signed.signature} (value ${usdc(BigInt(prepared.value.amount))}, balance before ${before ? usdc(decodeTokenAccount(before).amount) : "?"})`);
      const r = await awaitTx(rpc, rec);
      if (r.state !== "finalized" || r.outcome.err !== null) stop(`exit ${item.key}: ${r.state === "finalized" ? `failed ${JSON.stringify(r.outcome.err)}` : r.state}; rerun to reconcile`);
    }
    await w.notes.sync();
    const note = w.deps.store.note(item.noteId)!;
    rows.push({ note: item.key, owner: owner.address, value: note.value.toString(), walletNoteState: note.state, ...(await txDetails(rec.signature)) });
    console.log(`  exit ${item.key}: finalized (${explorerTx(rec.signature)})`);
  }
  evidence("exits", {
    exits: rows,
    note: "Public exit needs no approved-set membership; it reveals the note's label, value and refund address (linkable to the deposit) and pays only the refund authority's ATA.",
    proofTimingsMs: w.state.proofTimings.filter((t) => t.circuit === "exit"),
  });
}

async function summary(w: World): Promise<void> {
  const cu: Record<string, string[]> = {};
  const add = (name: string, v: unknown) => {
    if (typeof v === "string") (cu[name] ??= []).push(v);
  };
  for (const o of OWNERS) {
    const r = w.state.deposits[o];
    if (r) add("deposit", (await finalizedOutcome(rpc, r.signature))?.computeUnitsConsumed);
  }
  for (const row of w.relayerDb.prepare(`SELECT kind, signature FROM crank_attempt WHERE state = 'finalized'`).all() as Array<{ kind: string; signature: string }>) {
    add(row.kind === "insert" ? "insert_leaf" : "skip_refunded_deposit", (await finalizedOutcome(rpc, row.signature))?.computeUnitsConsumed);
  }
  if (w.state.approveRoot) add("update_approved_root", (await finalizedOutcome(rpc, w.state.approveRoot.signature))?.computeUnitsConsumed);
  const fr = w.state.purchaseId ? w.deps.store.funding(w.state.purchaseId) : undefined;
  if (fr?.relayer_withdrawal_id) {
    const v = w.withdrawals.view(fr.relayer_withdrawal_id);
    if (v?.signature) add("spend_private", (await finalizedOutcome(rpc, v.signature))?.computeUnitsConsumed);
  }
  for (const e of Object.values(w.state.exits)) if (e) add("exit_public (+ idempotent ATA create)", (await finalizedOutcome(rpc, e.signature))?.computeUnitsConsumed);
  const rent = {
    perDeposit: (await rpc.getMinimumBalanceForRentExemption(234n).send()) + (await rpc.getMinimumBalanceForRentExemption(49n).send()),
    perSpend: (await rpc.getMinimumBalanceForRentExemption(130n).send()) + (await rpc.getMinimumBalanceForRentExemption(50n).send()),
    perExit: await rpc.getMinimumBalanceForRentExemption(50n).send(),
    freshPayerAta: await rpc.getMinimumBalanceForRentExemption(165n).send(),
  };
  evidence("summary", {
    programId: w.manifest.program.programId,
    poolState: w.manifest.pool.poolState,
    computeUnitsOnDevnet: cu,
    computeUnitsNote: "computeUnitsConsumed from finalized devnet transactions, including the 150 CU SetComputeUnitLimit instruction",
    rentLamportsOnDevnet: Object.fromEntries(Object.entries(rent).map(([k, v]) => [k, v.toString()])),
    proofTimingsMs: w.state.proofTimings,
    proofTimingNote: "snarkjs fullProve on this host, measured around the wallet/crank prover call",
    sponsorTotals: Object.fromEntries(Object.entries(sponsorTotals(w.relayerDb)).map(([k, x]) => [k, x.toString()])),
    files: ["m2-deploy.json", "m2-deposits.json", "m2-inserts.json", "m2-approve-root.json", "m2-spend.json", "m2-change-insert.json", "m2-merchant.json", "m2-exits.json"],
  });
}

// ---------------------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Veilo M2 private smoke — ${execute ? "EXECUTE (signing enabled)" : "DRY RUN (read-only, nothing is signed)"}`);
  console.log(`RPC ${redactUrl(config.network.rpcUrl)}`);
  console.log(`network profile: ${(await verifyNetwork(config)).label}`);
  const roles = readRoles();
  const problems = checkRoleFiles(roles);
  if (problems.length) stop(`role keys: ${problems.join("; ")}`);
  const prover = new SnarkjsProver(rootDir);
  const proverOk = prover.available() && existsSync(prover.paths("insert").zkeyPath);
  const support = checkFacilitatorSupport(await fetchFacilitatorSupported(config.network.facilitatorUrl), { network: config.network.caip2, mint });
  if (!support.supported) stop(`facilitator does not support exact/devnet for the mint: ${support.reason}`);
  const pr = await fetchEchoChallenge();
  const b = await echoBinding(support.feePayers);
  const verified = await verifyPaymentRequired(pr, { origin: b.origin, network: b.network, mint: b.mint, payTo: b.payTo, merchantAta: b.merchantAta, maxAmount: PAYOUT, exactAmount: PAYOUT, allowedFeePayers: b.allowedFeePayers });
  console.log(`merchant: Echo challenge verified (${verified.amount} base units to ${ECHO_MERCHANT}, fee payer ${verified.feePayer})`);
  console.log(`proving files: ${proverOk ? "present and hash-pinned" : "MISSING (run pnpm test:circuits)"}`);

  const balances: string[] = [];
  for (const r of [...OWNERS, "sponsor", "approvalAuthority"] as const) {
    const pk = roles.roles[r].publicKey;
    const tokenAcct = await getAccount(rpc, await ata(pk, mint));
    balances.push(`  ${r.padEnd(18)} ${pk} ${sol(await lamportsOf(rpc, pk))}${tokenAcct ? `, ${usdc(decodeTokenAccount(tokenAcct.data).amount)}` : ", no token account"}`);
  }
  console.log(`balances:\n${balances.join("\n")}`);

  const manifestPath = config.pool.deploymentManifestPath;
  const deployment = await verifyDeployment({ manifestPath, repoRoot: rootDir, programId: config.pool.programId, poolId: config.pool.poolId, mint, chain: createRpcRelayerChain(config.network.rpcUrl) });
  const planText = [
    `1. deposits: ${OWNERS.join(", ")} each deposit ${usdc(DEPOSIT_AMOUNT)} (owner signs and pays PendingDeposit + SeenPrecommitment rent and the fee)`,
    "2. insert crank (sponsor): insert_leaf for both deposits (real insert proofs)",
    "3. approve-root (approval authority): publish approved labels for the synthetic participants",
    `4. spend (wallet → relayer): real spend proof from participant A's note; payout ${usdc(PAYOUT)} to a fresh payer; sponsor creates its ATA and submits spend_private`,
    "5. insert crank: insert the change note",
    `6. merchant: fresh payer pays Echo ${usdc(PAYOUT)} via x402 exact (facilitator pays the fee)`,
    "7. exits: participant B exits the original note; participant A exits the change note",
  ];
  if (deployment.state !== "verified") {
    console.log(`\ndeployment: ${deployment.state} (${deployment.reason}) — run pnpm deploy:devnet first`);
    console.log(`plan once deployed:\n  ${planText.join("\n  ")}`);
    console.log("\nDRY RUN complete: nothing was signed or sent.");
    if (execute) stop("pool not deployed");
    return;
  }
  const manifest = parseDeploymentManifest(deployment.manifest);
  assertManifestMatches(manifest, { programId: config.pool.programId, poolId: config.pool.poolId, mint, circuitHashes: prover.circuitHashes() });
  console.log(`deployment: verified (program ${manifest.program.programId}, pool ${manifest.pool.poolState})`);
  const st = readJsonOr<SmokeState | null>(STATE_PATH, null);
  console.log(`smoke state: ${st ? `stage ${st.stage}; deposits ${Object.keys(st.deposits).join(",") || "-"}; purchase ${st.purchaseId ?? "-"}; exits ${Object.keys(st.exits).join(",") || "-"}` : "not started"}`);
  if (!execute) {
    const p = await getPoseidon();
    const chain = createRpcRelayerChain(config.network.rpcUrl);
    const db = openRelayerDb(join(SMOKE_DIR, "relayer-dryrun.sqlite"));
    const ix = new Indexer(db, chain, p, address(manifest.program.programId), address(manifest.pool.poolState), address(manifest.pool.approvalState), repoPath(process.env.APPROVED_LABELS_PATH?.trim() || "artifacts/deployment/approved-labels.json"));
    const { view } = await ix.replay();
    db.close();
    console.log(`public state: consistent ${view.consistent}; leaves ${view.leaves.length}; queue ${view.pool.queueHead}/${view.pool.queueTail}; liability ${view.pool.liability}; approved v${view.approved.version}`);
    for (const o of OWNERS) {
      // A participant whose deposit is already recorded no longer needs the test USDC.
      if (st?.deposits[o]) continue;
      const t = await getAccount(rpc, await ata(roles.roles[o].publicKey, mint));
      if (!t || decodeTokenAccount(t.data).amount < DEPOSIT_AMOUNT) console.log(`  WARNING ${o} holds less than ${usdc(DEPOSIT_AMOUNT)}: run pnpm deploy:devnet -- --fund-test-usdc --execute --confirm first`);
    }
    console.log(`plan:\n  ${planText.join("\n  ")}`);
    console.log("\nDRY RUN complete: nothing was signed or sent. Execute with: pnpm demo:private-smoke -- --execute --confirm");
    return;
  }
  if (!proverOk) stop("proving files missing; run pnpm test:circuits");
  acquireRunLock(join(SMOKE_DIR, "run.lock"));
  const w = await buildWorld(roles, manifest, support.feePayers);
  try {
    const stopAfter = (step: StopPoint): boolean => {
      if (STOP_AFTER !== step) return false;
      console.log(`\nstopped after "${step}" as requested (--stop-after); rerun without it to continue`);
      return true;
    };
    console.log("\n[1/7] deposits");
    await stepDeposits(w);
    if (stopAfter("deposits")) return;
    console.log("[2/7] insert deposits");
    if (OWNERS.some((o) => !INSERTED.has(w.deps.store.note(w.state.deposits[o]!.noteId)!.state))) await stepInsertDeposits(w);
    if (stopAfter("inserts")) return;
    console.log("[3/7] approve root");
    await stepApproveRoot(w);
    if (stopAfter("approve-root")) return;
    console.log("[4/7] private spend");
    await stepSpend(w);
    if (stopAfter("spend")) return;
    console.log("[5/7] insert change");
    await stepInsertChange(w);
    if (stopAfter("change-insert")) return;
    console.log("[6/7] merchant payment");
    // The Echo merchant settles on devnet only; a local rehearsal never contacts it with a payment.
    if (PROFILE === "devnet") await stepMerchant(w);
    else console.log("  skipped in local rehearsal (Echo/PayAI settle on devnet only)");
    if (stopAfter("merchant")) return;
    console.log("[7/7] public exits");
    await stepExits(w);
    await summary(w);
    console.log(`\nM2 smoke complete. Evidence in ${relative(rootDir, EVIDENCE_DIR)}/m2-*.json`);
  } finally {
    w.close();
  }
}

// Exit explicitly: proving worker threads would otherwise keep the process alive after completion.
main().then(
  () => process.exit(0),
  (error: unknown) => {
    const e = error as Error;
    console.error(`\ndemo:private-smoke stopped: ${e.name === "Stop" ? "" : `${e.name}: `}${e.message}`);
    process.exit(1);
  },
);
