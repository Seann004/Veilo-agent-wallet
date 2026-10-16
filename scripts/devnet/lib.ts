// Shared helpers for the devnet deployment and M2 smoke scripts. Key files are read only to
// build signers; their contents are never printed or written anywhere else.
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDevnetRpc, isMainnetIdentifier, verifyChainIdentity, type VeiloConfig } from "@veilo/contracts";
import {
  AccountRole,
  addSignersToTransactionMessage,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  signature as toSignature,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * "devnet" is the only profile that touches a public cluster. "local-rehearsal" exercises the same
 * scripts against a loopback solana-test-validator with throwaway keys; every file it writes
 * lives under work/rehearsal and it refuses any non-loopback RPC.
 */
export const PROFILE: "devnet" | "local-rehearsal" = process.env.VEILO_DEPLOY_PROFILE === "local-rehearsal" ? "local-rehearsal" : "devnet";
const REHEARSAL_DIR = join(REPO, "work", "rehearsal");
export const ROLE_KEYS_DIR = PROFILE === "devnet" ? join(REPO, "work", "keys", "devnet") : join(REHEARSAL_DIR, "keys");
export const ROLES_PATH = PROFILE === "devnet" ? join(REPO, "artifacts", "deployment", "roles.devnet.json") : join(REHEARSAL_DIR, "roles.json");
export const DEPLOY_PROGRESS_PATH = PROFILE === "devnet" ? join(REPO, "artifacts", "deployment", "devnet.progress.json") : join(REHEARSAL_DIR, "progress.json");
export const EVIDENCE_DIR = PROFILE === "devnet" ? join(REPO, "artifacts", "evidence") : join(REHEARSAL_DIR, "evidence");
export const SMOKE_DIR = PROFILE === "devnet" ? join(REPO, "work", "devnet-smoke") : join(REHEARSAL_DIR, "smoke");

/**
 * Chain identity gate for these scripts. Devnet: the shared fail-closed genesis/mint check.
 * Local rehearsal: loopback RPC only, and the mint must still be an initialized 6-decimal
 * original-SPL-Token mint.
 */
export async function verifyNetwork(config: VeiloConfig): Promise<{ genesisHash: string; label: string }> {
  if (PROFILE === "devnet") {
    const id = await verifyChainIdentity(config);
    return { genesisHash: id.genesisHash, label: "devnet" };
  }
  const host = new URL(config.network.rpcUrl).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") throw new Error("local-rehearsal profile accepts only a loopback RPC URL");
  const rpc = makeRpc(config.network.rpcUrl);
  const genesisHash = await rpc.getGenesisHash().send();
  if (genesisHash === config.network.genesisHash || isMainnetIdentifier(genesisHash)) throw new Error("local-rehearsal profile refuses devnet/mainnet RPC endpoints");
  const m = await getAccount(rpc, config.network.mint);
  if (!m || m.owner !== TOKEN_PROGRAM) throw new Error("rehearsal mint missing or not owned by SPL Token");
  const info = decodeMint(m.data);
  if (info.decimals !== 6 || !info.initialized) throw new Error("rehearsal mint must be initialized with 6 decimals");
  return { genesisHash, label: "LOCAL REHEARSAL (loopback test validator, not devnet)" };
}

export const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
export const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const COMPUTE_BUDGET_PROGRAM = address("ComputeBudget111111111111111111111111111111");
export const UPGRADEABLE_LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");
export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const LAMPORTS_PER_SIGNATURE = 5_000n;

export const ROLES = {
  deployer: { file: "deployer.json", purpose: "program upgrade authority, deploy fee payer and initialize_pool signer" },
  programId: { file: "program-id.json", purpose: "privacy-pool program address keypair (signs only the first deploy)" },
  programBuffer: { file: "program-buffer.json", purpose: "deploy buffer keypair, reused so an interrupted deploy resumes" },
  sponsor: { file: "sponsor-relayer.json", purpose: "relayer and fee/rent sponsor (one key: manifest sponsor == relayer)" },
  merchant: { file: "merchant.json", purpose: "gateway merchant payTo owner (receives x402 payments to its ATA)" },
  approvalAuthority: { file: "approval-authority.json", purpose: "signs update_approved_root only" },
  configAuthority: { file: "config-authority.json", purpose: "signs update_config only (bounded caps/pause)" },
  testOwnerA: { file: "test-owner-a.json", purpose: "synthetic test participant A (deposit refund authority)" },
  testOwnerB: { file: "test-owner-b.json", purpose: "synthetic test participant B (deposit refund authority)" },
} as const;
export type RoleName = keyof typeof ROLES;

export interface RolesFile {
  schema: "veilo-devnet-roles-v1";
  cluster: "devnet";
  note: string;
  /** 32-byte pool instance id (hex), chosen once. */
  poolId: string;
  createdAt: string;
  roles: Record<RoleName, { publicKey: string; keyPath: string; purpose: string }>;
}

export const repoPath = (p: string): string => (isAbsolute(p) ? p : join(REPO, p));
export const explorerTx = (sig: string): string => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const explorerAddress = (a: string): string => `https://explorer.solana.com/address/${a}?cluster=devnet`;
export const sol = (lamports: bigint): string => `${(Number(lamports) / 1e9).toFixed(6)} SOL`;
export const usdc = (base: bigint): string => `${(Number(base) / 1e6).toFixed(6)} test USDC`;
export const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function readKeyBytes(path: string): Uint8Array {
  if (!existsSync(path)) throw new Error(`key file not found: ${path}`);
  let arr: unknown;
  try {
    arr = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`key file is not JSON: ${path}`);
  }
  if (!Array.isArray(arr) || arr.length !== 64 || !arr.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) throw new Error(`not a 64-byte Solana keypair file: ${path}`);
  return Uint8Array.from(arr as number[]);
}

/** Public key of a Solana CLI keypair file, after checking the stored public half matches the seed. */
export function publicKeyOfKeyFile(path: string): string {
  const bytes = readKeyBytes(path);
  try {
    const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, bytes.subarray(0, 32)]), format: "der", type: "pkcs8" });
    const x = Buffer.from(createPublicKey(priv).export({ format: "jwk" }).x ?? "", "base64url");
    if (!x.equals(Buffer.from(bytes.subarray(32)))) throw new Error(`key file public half does not match its seed: ${path}`);
    return getAddressDecoder().decode(x);
  } finally {
    bytes.fill(0);
  }
}

export async function loadSigner(path: string, expected?: string): Promise<KeyPairSigner> {
  const bytes = readKeyBytes(path);
  try {
    const signer = await createKeyPairSignerFromBytes(bytes);
    if (expected !== undefined && signer.address !== expected) throw new Error(`key file ${path} is ${signer.address}, expected ${expected}`);
    return signer;
  } finally {
    bytes.fill(0);
  }
}

export function readRoles(): RolesFile {
  if (!existsSync(ROLES_PATH)) throw new Error("artifacts/deployment/roles.devnet.json not found; run pnpm keys:init");
  const r = JSON.parse(readFileSync(ROLES_PATH, "utf8")) as RolesFile;
  if (r.schema !== "veilo-devnet-roles-v1" || r.cluster !== "devnet" || !/^[0-9a-f]{64}$/.test(r.poolId)) throw new Error("roles.devnet.json is malformed");
  for (const name of Object.keys(ROLES) as RoleName[]) if (!r.roles[name]) throw new Error(`roles.devnet.json lacks role ${name}; run pnpm keys:init`);
  return r;
}

/** Every role key file exists and holds the recorded public key. */
export function checkRoleFiles(r: RolesFile): string[] {
  const problems: string[] = [];
  for (const name of Object.keys(ROLES) as RoleName[]) {
    const { keyPath, publicKey } = r.roles[name];
    try {
      const pk = publicKeyOfKeyFile(repoPath(keyPath));
      if (pk !== publicKey) problems.push(`${name}: ${keyPath} holds ${pk}, roles file records ${publicKey}`);
    } catch (error) {
      problems.push(`${name}: ${(error as Error).message}`);
    }
  }
  return problems;
}

export const roleSigner = (r: RolesFile, name: RoleName) => loadSigner(repoPath(r.roles[name].keyPath), r.roles[name].publicKey);

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
  renameSync(tmp, path);
}

export function readJsonOr<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
}

export function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
export const hasFlag = (name: string): boolean => process.argv.includes(name);

/** Signing happens only with both flags; anything else is a read-only dry run. */
export function executeMode(): boolean {
  const execute = hasFlag("--execute");
  const confirm = hasFlag("--confirm");
  if (execute !== confirm) throw new Error("--execute and --confirm must be given together; without both nothing is signed");
  return execute && confirm;
}

// ---------------------------------------------------------------------------------------
// Instruction encoders (fixed layouts of the System, SPL Token, ATA and compute-budget programs)

const enc = getAddressEncoder();
const u64le = (x: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, x, true);
  return b;
};

export function systemTransferIx(from: Address, to: Address, lamports: bigint): Instruction {
  const data = new Uint8Array(12);
  data.set([2, 0, 0, 0]);
  data.set(u64le(lamports), 4);
  return { programAddress: SYSTEM_PROGRAM, accounts: [{ address: from, role: AccountRole.WRITABLE_SIGNER }, { address: to, role: AccountRole.WRITABLE }], data };
}

export function computeUnitLimitIx(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM, data };
}

export function createAtaIdempotentIx(payer: Address, ata: Address, owner: Address, mint: Address): Instruction {
  return {
    programAddress: ATA_PROGRAM,
    accounts: [
      { address: payer, role: AccountRole.WRITABLE_SIGNER },
      { address: ata, role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.READONLY },
      { address: mint, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
    ],
    data: Uint8Array.of(1),
  };
}

export function transferCheckedIx(source: Address, mint: Address, destination: Address, authority: Address, amount: bigint, decimals: number): Instruction {
  const data = new Uint8Array(10);
  data[0] = 12;
  data.set(u64le(amount), 1);
  data[9] = decimals;
  return {
    programAddress: TOKEN_PROGRAM,
    accounts: [
      { address: source, role: AccountRole.WRITABLE },
      { address: mint, role: AccountRole.READONLY },
      { address: destination, role: AccountRole.WRITABLE },
      { address: authority, role: AccountRole.READONLY_SIGNER },
    ],
    data,
  };
}

export async function ata(owner: Address | string, mint: Address | string): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: ATA_PROGRAM, seeds: [enc.encode(owner as Address), enc.encode(TOKEN_PROGRAM), enc.encode(mint as Address)] });
  return pda;
}

export async function programDataAddress(programId: Address | string): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: UPGRADEABLE_LOADER, seeds: [enc.encode(programId as Address)] });
  return pda;
}

// ---------------------------------------------------------------------------------------
// Account decoders

export interface MintInfo {
  decimals: number;
  initialized: boolean;
  supply: bigint;
  mintAuthority: string | null;
  freezeAuthority: string | null;
}

const dec = getAddressDecoder();

export function decodeMint(data: Uint8Array): MintInfo {
  if (data.length !== 82) throw new Error(`mint account is ${data.length} bytes, expected 82`);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    mintAuthority: dv.getUint32(0, true) === 1 ? dec.decode(data.subarray(4, 36)) : null,
    supply: dv.getBigUint64(36, true),
    decimals: data[44]!,
    initialized: data[45] === 1,
    freezeAuthority: dv.getUint32(46, true) === 1 ? dec.decode(data.subarray(50, 82)) : null,
  };
}

export interface TokenAccountInfo {
  mint: string;
  owner: string;
  amount: bigint;
  hasDelegate: boolean;
  state: number;
  hasCloseAuthority: boolean;
}

export function decodeTokenAccount(data: Uint8Array): TokenAccountInfo {
  if (data.length !== 165) throw new Error(`token account is ${data.length} bytes, expected 165`);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    mint: dec.decode(data.subarray(0, 32)),
    owner: dec.decode(data.subarray(32, 64)),
    amount: dv.getBigUint64(64, true),
    hasDelegate: dv.getUint32(72, true) !== 0,
    state: data[108]!,
    hasCloseAuthority: dv.getUint32(129, true) !== 0,
  };
}

/** Upgradeable-loader ProgramData: tag 3, u64 slot, Option<Pubkey> authority, then the ELF. */
export function decodeProgramData(data: Uint8Array): { slot: bigint; upgradeAuthority: string | null; elf: Uint8Array } {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 45 || dv.getUint32(0, true) !== 3) throw new Error("not an upgradeable-loader ProgramData account");
  return { slot: dv.getBigUint64(4, true), upgradeAuthority: data[12] === 1 ? dec.decode(data.subarray(13, 45)) : null, elf: data.subarray(45) };
}

/** Upgradeable-loader Program account: tag 2 followed by the ProgramData address. */
export function decodeProgramAccount(data: Uint8Array): { programData: string } {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length !== 36 || dv.getUint32(0, true) !== 2) throw new Error("not an upgradeable-loader Program account");
  return { programData: dec.decode(data.subarray(4, 36)) };
}

// ---------------------------------------------------------------------------------------
// RPC and transactions

export type Rpc = ReturnType<typeof createSolanaRpc>;
export const makeRpc = (url: string): Rpc => createDevnetRpc(url);

export interface AccountSnapshot {
  lamports: bigint;
  owner: string;
  executable: boolean;
  data: Uint8Array;
}

export async function getAccount(rpc: Rpc, a: Address | string, commitment: "finalized" | "confirmed" = "finalized"): Promise<AccountSnapshot | null> {
  const { value } = await rpc.getAccountInfo(a as Address, { encoding: "base64", commitment }).send();
  if (!value) return null;
  return { lamports: value.lamports, owner: value.owner, executable: value.executable, data: new Uint8Array(Buffer.from(value.data[0], "base64")) };
}

export async function lamportsOf(rpc: Rpc, a: Address | string): Promise<bigint> {
  return (await rpc.getBalance(a as Address, { commitment: "finalized" }).send()).value;
}

export const rentFor = async (rpc: Rpc, bytes: number): Promise<bigint> => rpc.getMinimumBalanceForRentExemption(BigInt(bytes)).send();

/** A transaction whose signature was persisted before it was sent. */
export interface SentTx {
  signature: string;
  lastValidBlockHeight: string;
  sentAt: string;
}

export interface TxOutcome {
  signature: string;
  slot: string;
  err: unknown;
  fee: string;
  computeUnitsConsumed: string | null;
  explorer: string;
}

/** Reads a finalized transaction's outcome, or null if it is not finalized (yet). */
export async function finalizedOutcome(rpc: Rpc, sig: string): Promise<TxOutcome | null> {
  const tx = await rpc.getTransaction(toSignature(sig), { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 }).send();
  if (!tx) return null;
  return {
    signature: sig,
    slot: tx.slot.toString(),
    err: tx.meta?.err ?? null,
    fee: (tx.meta?.fee ?? 0n).toString(),
    computeUnitsConsumed: tx.meta?.computeUnitsConsumed === undefined ? null : String(tx.meta.computeUnitsConsumed),
    explorer: explorerTx(sig),
  };
}

/**
 * Waits for a persisted transaction to finalize. Returns "expired" only when its blockhash can
 * no longer land and the signature is unknown, so the caller may rebuild without double-sending.
 */
export async function awaitTx(rpc: Rpc, sent: SentTx, timeoutMs = 150_000): Promise<{ state: "finalized"; outcome: TxOutcome } | { state: "expired" } | { state: "pending" }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { value } = await rpc.getSignatureStatuses([toSignature(sent.signature)], { searchTransactionHistory: true }).send();
    const st = value[0];
    if (st?.confirmationStatus === "finalized") {
      for (let i = 0; i < 10; i++) {
        const o = await finalizedOutcome(rpc, sent.signature);
        if (o) return { state: "finalized", outcome: o };
        await sleep(2_000);
      }
    }
    if (!st) {
      const height = await rpc.getBlockHeight({ commitment: "finalized" }).send();
      if (height > BigInt(sent.lastValidBlockHeight)) return { state: "expired" };
    }
    if (Date.now() > deadline) return { state: "pending" };
    await sleep(3_000);
  }
}

/**
 * Builds, signs and sends one transaction. `persist` runs with the signature before the send,
 * so an interrupted run finds the attempt and reconciles it instead of signing a new one.
 */
export async function signAndSend(
  rpc: Rpc,
  feePayer: KeyPairSigner,
  extraSigners: KeyPairSigner[],
  ixs: Instruction[],
  persist: (sent: SentTx) => void,
): Promise<SentTx> {
  const { value: bh } = await rpc.getLatestBlockhash({ commitment: "finalized" }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
    (m) => addSignersToTransactionMessage(extraSigners, m),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  const sent: SentTx = { signature: getSignatureFromTransaction(tx), lastValidBlockHeight: bh.lastValidBlockHeight.toString(), sentAt: new Date().toISOString() };
  persist(sent);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64", preflightCommitment: "confirmed" }).send();
  return sent;
}

/** Sends a pre-signed base64 wire transaction (simulated by the RPC node first). */
export async function sendWire(rpc: Rpc, wire: string): Promise<void> {
  await rpc.sendTransaction(wire as Parameters<Rpc["sendTransaction"]>[0], { encoding: "base64", preflightCommitment: "confirmed" }).send();
}

/**
 * Single-run lock: a second concurrent run against the same state stops instead of racing it.
 * A lock left by a process that no longer exists is taken over.
 */
export function acquireRunLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" });
      const release = () => {
        try {
          if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path);
        } catch {
          // already gone
        }
      };
      process.once("exit", release);
      return release;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(readFileSync(path, "utf8"));
      if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) throw new Error(`another run (pid ${pid}) holds ${path}; wait for it to finish or stop it`, { cause: error });
      unlinkSync(path);
    }
  }
  throw new Error(`could not take the run lock ${path}`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
