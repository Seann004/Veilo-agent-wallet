import { AccountRole, address, type AccountMeta, type Address, type Instruction } from "@solana/kit";
import { accountDiscriminator, BorshReader, BorshWriter, bytesEqual, eventDiscriminator, instructionDiscriminator } from "./anchor";
import { EncodingError, fromBe32, toBe32 } from "./field";
import type { WithdrawalIntent } from "./intent";
import type { SolanaProof } from "./proof";
import { addressBytes } from "./label";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./pda";

export const SYSTEM_PROGRAM_ID = address("11111111111111111111111111111111");

/** Instruction names exactly as the protocol and the program's IDL spell them. */
export const POOL_INSTRUCTIONS = [
  "initialize_pool",
  "deposit",
  "refund_pending_deposit",
  "insert_leaf",
  "skip_refunded_deposit",
  "update_approved_root",
  "spend_private",
  "exit_public",
  "update_config",
] as const;
export type PoolInstructionName = (typeof POOL_INSTRUCTIONS)[number];

/** Account names per instruction, in the protocol's listed order. */
export const POOL_INSTRUCTION_ACCOUNTS: Record<PoolInstructionName, readonly string[]> = {
  initialize_pool: [
    "deployer",
    "program_data",
    "pool_state",
    "vault_authority",
    "mint",
    "vault",
    "approval_state",
    "token_program",
    "associated_token_program",
    "system_program",
  ],
  deposit: [
    "depositor",
    "payer",
    "pool_state",
    "source",
    "vault",
    "pending_deposit",
    "seen_precommitment",
    "token_program",
    "system_program",
  ],
  refund_pending_deposit: [
    "refund_authority",
    "pool_state",
    "pending_deposit",
    "vault",
    "vault_authority",
    "destination",
    "token_program",
  ],
  insert_leaf: ["submitter", "pool_state", "pending_deposit", "pending_change"],
  skip_refunded_deposit: ["submitter", "pool_state", "pending_deposit"],
  update_approved_root: ["approval_authority", "pool_state", "approval_state"],
  spend_private: [
    "payer",
    "relayer",
    "pool_state",
    "approval_state",
    "vault",
    "vault_authority",
    "destination",
    "relayer_fee_account",
    "spent_nullifier",
    "pending_change",
    "token_program",
    "system_program",
  ],
  exit_public: [
    "refund_authority",
    "payer",
    "pool_state",
    "vault",
    "vault_authority",
    "destination",
    "spent_nullifier",
    "token_program",
    "system_program",
  ],
  update_config: ["config_authority", "pool_state"],
};

/** Instruction argument names and Borsh shapes, in order. */
export const POOL_INSTRUCTION_ARGS: Record<PoolInstructionName, readonly string[]> = {
  initialize_pool: ["pool_id", "genesis_hash", "expected_decimals", "approval_authority", "config_authority"],
  deposit: ["amount", "precommitment", "salt"],
  refund_pending_deposit: [],
  insert_leaf: ["proof", "new_root"],
  skip_refunded_deposit: [],
  update_approved_root: ["new_root"],
  spend_private: ["proof", "state_root", "nullifier_hash", "new_commitment", "intent"],
  exit_public: ["proof", "state_root", "nullifier_hash", "value", "salt"],
  update_config: ["args"],
};

const meta = (addr: Address | string, role: AccountRole): AccountMeta => ({ address: addr as Address, role });
const ro = (a: Address | string) => meta(a, AccountRole.READONLY);
const rw = (a: Address | string) => meta(a, AccountRole.WRITABLE);
const roSigner = (a: Address | string) => meta(a, AccountRole.READONLY_SIGNER);
const rwSigner = (a: Address | string) => meta(a, AccountRole.WRITABLE_SIGNER);

function ix(program: Address, name: PoolInstructionName, accounts: AccountMeta[], args: (w: BorshWriter) => void): Instruction {
  const expected = POOL_INSTRUCTION_ACCOUNTS[name].length;
  if (accounts.length !== expected) throw new EncodingError(`${name}: expected ${expected} accounts, got ${accounts.length}`);
  const w = new BorshWriter().bytes(instructionDiscriminator(name));
  args(w);
  return { programAddress: program, accounts, data: w.finish() };
}

const field32 = (w: BorshWriter, x: bigint) => w.bytes(toBe32(x), 32);

function writeProof(w: BorshWriter, p: SolanaProof): void {
  w.bytes(p.a, 64).bytes(p.b, 128).bytes(p.c, 64);
}

/** Borsh form of the on-chain `WithdrawalIntent` (u64 little-endian, Option = tag byte). */
export function encodeWithdrawalIntent(w: BorshWriter, intent: WithdrawalIntent): void {
  w.bytes(intent.destinationTokenAccount, 32)
    .bytes(intent.destinationOwner, 32)
    .u64(intent.payoutAmount)
    .u64(intent.relayerFee)
    .option(intent.relayer, (x, v) => x.bytes(v, 32))
    .option(intent.relayerFeeTokenAccount, (x, v) => x.bytes(v, 32))
    .u64(intent.validUntilSlot);
}

// Anchor passes the program id in place of an absent optional account.
const optional = (program: Address, a: Address | null, role: AccountRole) => (a === null ? ro(program) : meta(a, role));

export interface InitializePoolAccounts {
  deployer: Address;
  programData: Address;
  poolState: Address;
  vaultAuthority: Address;
  mint: Address;
  vault: Address;
  approvalState: Address;
}

export function initializePoolInstruction(
  program: Address,
  a: InitializePoolAccounts,
  args: { poolId: Uint8Array; genesisHash: Uint8Array; expectedDecimals: number; approvalAuthority: Address; configAuthority: Address },
): Instruction {
  return ix(
    program,
    "initialize_pool",
    [
      rwSigner(a.deployer),
      ro(a.programData),
      rw(a.poolState),
      ro(a.vaultAuthority),
      ro(a.mint),
      rw(a.vault),
      rw(a.approvalState),
      ro(TOKEN_PROGRAM_ID),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
    ],
    (w) =>
      w
        .bytes(args.poolId, 32)
        .bytes(args.genesisHash, 32)
        .u8(args.expectedDecimals)
        .pubkey(args.approvalAuthority)
        .pubkey(args.configAuthority),
  );
}

export interface DepositAccounts {
  depositor: Address;
  payer: Address;
  poolState: Address;
  source: Address;
  vault: Address;
  pendingDeposit: Address;
  seenPrecommitment: Address;
}

export function depositInstruction(
  program: Address,
  a: DepositAccounts,
  args: { amount: bigint; precommitment: bigint; salt: Uint8Array },
): Instruction {
  if (args.precommitment === 0n) throw new EncodingError("precommitment must be nonzero");
  const depositorIsPayer = a.depositor === a.payer;
  return ix(
    program,
    "deposit",
    [
      depositorIsPayer ? rwSigner(a.depositor) : roSigner(a.depositor),
      rwSigner(a.payer),
      rw(a.poolState),
      rw(a.source),
      rw(a.vault),
      rw(a.pendingDeposit),
      rw(a.seenPrecommitment),
      ro(TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
    ],
    (w) => field32(w.u64(args.amount), args.precommitment).bytes(args.salt, 32),
  );
}

export interface RefundAccounts {
  refundAuthority: Address;
  poolState: Address;
  pendingDeposit: Address;
  vault: Address;
  vaultAuthority: Address;
  destination: Address;
}

export function refundPendingDepositInstruction(program: Address, a: RefundAccounts): Instruction {
  return ix(
    program,
    "refund_pending_deposit",
    [roSigner(a.refundAuthority), rw(a.poolState), rw(a.pendingDeposit), rw(a.vault), ro(a.vaultAuthority), rw(a.destination), ro(TOKEN_PROGRAM_ID)],
    () => {},
  );
}

export interface InsertLeafAccounts {
  submitter: Address;
  poolState: Address;
  /** Exactly one of pendingDeposit / pendingChange is set. */
  pendingDeposit: Address | null;
  pendingChange: Address | null;
}

export function insertLeafInstruction(program: Address, a: InsertLeafAccounts, args: { proof: SolanaProof; newRoot: bigint }): Instruction {
  if ((a.pendingDeposit === null) === (a.pendingChange === null)) {
    throw new EncodingError("insert_leaf needs exactly one queue record");
  }
  return ix(
    program,
    "insert_leaf",
    [
      roSigner(a.submitter),
      rw(a.poolState),
      optional(program, a.pendingDeposit, AccountRole.WRITABLE),
      optional(program, a.pendingChange, AccountRole.WRITABLE),
    ],
    (w) => {
      writeProof(w, args.proof);
      field32(w, args.newRoot);
    },
  );
}

export function skipRefundedDepositInstruction(
  program: Address,
  a: { submitter: Address; poolState: Address; pendingDeposit: Address },
): Instruction {
  return ix(program, "skip_refunded_deposit", [roSigner(a.submitter), rw(a.poolState), rw(a.pendingDeposit)], () => {});
}

export function updateApprovedRootInstruction(
  program: Address,
  a: { approvalAuthority: Address; poolState: Address; approvalState: Address },
  newRoot: bigint,
): Instruction {
  return ix(program, "update_approved_root", [roSigner(a.approvalAuthority), ro(a.poolState), rw(a.approvalState)], (w) =>
    field32(w, newRoot),
  );
}

export interface SpendPrivateAccounts {
  payer: Address;
  /** Required exactly when the intent names a relayer, and must equal it. */
  relayer: Address | null;
  poolState: Address;
  approvalState: Address;
  vault: Address;
  vaultAuthority: Address;
  destination: Address;
  relayerFeeAccount: Address | null;
  spentNullifier: Address;
  pendingChange: Address;
}

export interface SpendPrivateArgs {
  proof: SolanaProof;
  stateRoot: bigint;
  nullifierHash: bigint;
  newCommitment: bigint;
  intent: WithdrawalIntent;
}

export function spendPrivateInstruction(program: Address, a: SpendPrivateAccounts, args: SpendPrivateArgs): Instruction {
  const intentRelayer = args.intent.relayer;
  if ((intentRelayer === null) !== (a.relayer === null)) throw new EncodingError("relayer account must match intent.relayer");
  if (intentRelayer !== null && a.relayer !== null && !bytesEqual(addressBytes(a.relayer), intentRelayer)) {
    throw new EncodingError("relayer account differs from intent.relayer");
  }
  if (!bytesEqual(addressBytes(a.destination), args.intent.destinationTokenAccount)) {
    throw new EncodingError("destination differs from intent.destination_token_account");
  }
  if (args.newCommitment === 0n) throw new EncodingError("new commitment must be nonzero");
  const relayerIsPayer = a.relayer !== null && a.relayer === a.payer;
  return ix(
    program,
    "spend_private",
    [
      rwSigner(a.payer),
      a.relayer === null ? ro(program) : relayerIsPayer ? rwSigner(a.relayer) : roSigner(a.relayer),
      rw(a.poolState),
      ro(a.approvalState),
      rw(a.vault),
      ro(a.vaultAuthority),
      rw(a.destination),
      optional(program, a.relayerFeeAccount, AccountRole.WRITABLE),
      rw(a.spentNullifier),
      rw(a.pendingChange),
      ro(TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
    ],
    (w) => {
      writeProof(w, args.proof);
      field32(w, args.stateRoot);
      field32(w, args.nullifierHash);
      field32(w, args.newCommitment);
      encodeWithdrawalIntent(w, args.intent);
    },
  );
}

export interface ExitPublicAccounts {
  refundAuthority: Address;
  payer: Address;
  poolState: Address;
  vault: Address;
  vaultAuthority: Address;
  /** ATA(refund_authority, mint). */
  destination: Address;
  spentNullifier: Address;
}

export function exitPublicInstruction(
  program: Address,
  a: ExitPublicAccounts,
  args: { proof: SolanaProof; stateRoot: bigint; nullifierHash: bigint; value: bigint; salt: Uint8Array },
): Instruction {
  if (args.value <= 0n) throw new EncodingError("exit value must be > 0");
  const authorityIsPayer = a.refundAuthority === a.payer;
  return ix(
    program,
    "exit_public",
    [
      authorityIsPayer ? rwSigner(a.refundAuthority) : roSigner(a.refundAuthority),
      rwSigner(a.payer),
      rw(a.poolState),
      rw(a.vault),
      ro(a.vaultAuthority),
      rw(a.destination),
      rw(a.spentNullifier),
      ro(TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
    ],
    (w) => {
      writeProof(w, args.proof);
      field32(w, args.stateRoot);
      field32(w, args.nullifierHash);
      w.u64(args.value).bytes(args.salt, 32);
    },
  );
}

export interface ConfigUpdate {
  depositsPaused?: boolean | null;
  minDeposit?: bigint | null;
  maxDeposit?: bigint | null;
  liabilityCap?: bigint | null;
  maxRelayerFee?: bigint | null;
}

export function updateConfigInstruction(program: Address, a: { configAuthority: Address; poolState: Address }, args: ConfigUpdate): Instruction {
  return ix(program, "update_config", [roSigner(a.configAuthority), rw(a.poolState)], (w) =>
    w
      .option(args.depositsPaused, (x, v) => x.bool(v))
      .option(args.minDeposit, (x, v) => x.u64(v))
      .option(args.maxDeposit, (x, v) => x.u64(v))
      .option(args.liabilityCap, (x, v) => x.u64(v))
      .option(args.maxRelayerFee, (x, v) => x.u64(v)),
  );
}

// ---------------------------------------------------------------------------------------
// Accounts

function reader(name: string, data: Uint8Array, size: number): BorshReader {
  if (data.length !== size) throw new EncodingError(`${name}: expected ${size} bytes, got ${data.length}`);
  const r = new BorshReader(data);
  if (!bytesEqual(r.bytes(8), accountDiscriminator(name))) throw new EncodingError(`${name}: account discriminator mismatch`);
  return r;
}

const fe = (r: BorshReader): bigint => fromBe32(r.bytes(32));

export const ACCOUNT_SIZES = {
  PoolState: 1407,
  PendingDeposit: 234,
  PendingChange: 130,
  SeenPrecommitment: 49,
  SpentNullifier: 50,
  ApprovalState: 121,
} as const;

export interface PoolStateAccount {
  protocolVersion: number;
  bump: number;
  vaultAuthorityBump: number;
  mintDecimals: number;
  depositsPaused: boolean;
  rootsLen: number;
  rootsNext: number;
  poolId: Uint8Array;
  mint: Address;
  tokenProgram: Address;
  vault: Address;
  genesisHash: Uint8Array;
  configAuthority: Address;
  currentRoot: bigint;
  rootHistory: bigint[];
  nextLeafIndex: bigint;
  queueHead: bigint;
  queueTail: bigint;
  liability: bigint;
  minDeposit: bigint;
  maxDeposit: bigint;
  liabilityCap: bigint;
  maxRelayerFee: bigint;
  cumulativeDeposited: bigint;
  cumulativeOutflow: bigint;
}

export function decodePoolState(data: Uint8Array): PoolStateAccount {
  const r = reader("PoolState", data, ACCOUNT_SIZES.PoolState);
  const out: PoolStateAccount = {
    protocolVersion: r.u8(),
    bump: r.u8(),
    vaultAuthorityBump: r.u8(),
    mintDecimals: r.u8(),
    depositsPaused: r.bool(),
    rootsLen: r.u8(),
    rootsNext: r.u8(),
    poolId: r.bytes(32),
    mint: r.pubkey(),
    tokenProgram: r.pubkey(),
    vault: r.pubkey(),
    genesisHash: r.bytes(32),
    configAuthority: r.pubkey(),
    currentRoot: fe(r),
    rootHistory: Array.from({ length: 32 }, () => fe(r)),
    nextLeafIndex: r.u64(),
    queueHead: r.u64(),
    queueTail: r.u64(),
    liability: r.u64(),
    minDeposit: r.u64(),
    maxDeposit: r.u64(),
    liabilityCap: r.u64(),
    maxRelayerFee: r.u64(),
    cumulativeDeposited: r.u64(),
    cumulativeOutflow: r.u64(),
  };
  r.bytes(64);
  r.end();
  return out;
}

/** The live entries of the root ring buffer ("known roots" for spend and exit). */
export function knownRoots(pool: Pick<PoolStateAccount, "rootHistory" | "rootsLen">): bigint[] {
  return pool.rootHistory.slice(0, pool.rootsLen);
}

export const PENDING_DEPOSIT_STATE = { 0: "pending", 1: "inserted", 2: "refunded", 3: "skipped" } as const;
export const PENDING_CHANGE_STATE = { 0: "pending", 1: "inserted" } as const;

export interface PendingDepositAccount {
  pool: Address;
  queueSeq: bigint;
  refundAuthority: Address;
  salt: Uint8Array;
  label: bigint;
  precommitment: bigint;
  commitment: bigint;
  amount: bigint;
  state: (typeof PENDING_DEPOSIT_STATE)[keyof typeof PENDING_DEPOSIT_STATE];
  leafIndex: bigint;
  createdSlot: bigint;
  bump: number;
}

function enumOf<T extends Record<number, string>>(table: T, v: number, what: string): T[keyof T] {
  const s = table[v as keyof T];
  if (s === undefined) throw new EncodingError(`${what}: unknown state ${v}`);
  return s;
}

export function decodePendingDeposit(data: Uint8Array): PendingDepositAccount {
  const r = reader("PendingDeposit", data, ACCOUNT_SIZES.PendingDeposit);
  const out: PendingDepositAccount = {
    pool: r.pubkey(),
    queueSeq: r.u64(),
    refundAuthority: r.pubkey(),
    salt: r.bytes(32),
    label: fe(r),
    precommitment: fe(r),
    commitment: fe(r),
    amount: r.u64(),
    state: enumOf(PENDING_DEPOSIT_STATE, r.u8(), "PendingDeposit"),
    leafIndex: r.u64(),
    createdSlot: r.u64(),
    bump: r.u8(),
  };
  r.end();
  return out;
}

export interface PendingChangeAccount {
  pool: Address;
  queueSeq: bigint;
  nullifierHash: bigint;
  commitment: bigint;
  state: (typeof PENDING_CHANGE_STATE)[keyof typeof PENDING_CHANGE_STATE];
  leafIndex: bigint;
  createdSlot: bigint;
  bump: number;
}

export function decodePendingChange(data: Uint8Array): PendingChangeAccount {
  const r = reader("PendingChange", data, ACCOUNT_SIZES.PendingChange);
  const out: PendingChangeAccount = {
    pool: r.pubkey(),
    queueSeq: r.u64(),
    nullifierHash: fe(r),
    commitment: fe(r),
    state: enumOf(PENDING_CHANGE_STATE, r.u8(), "PendingChange"),
    leafIndex: r.u64(),
    createdSlot: r.u64(),
    bump: r.u8(),
  };
  r.end();
  return out;
}

export interface SpentNullifierAccount {
  pool: Address;
  kind: "spend" | "exit";
  slot: bigint;
  bump: number;
}

export function decodeSpentNullifier(data: Uint8Array): SpentNullifierAccount {
  const r = reader("SpentNullifier", data, ACCOUNT_SIZES.SpentNullifier);
  const pool = r.pubkey();
  const k = r.u8();
  if (k !== 1 && k !== 2) throw new EncodingError("SpentNullifier: unknown kind");
  const out: SpentNullifierAccount = { pool, kind: k === 1 ? "spend" : "exit", slot: r.u64(), bump: r.u8() };
  r.end();
  return out;
}

export interface ApprovalStateAccount {
  pool: Address;
  approvalAuthority: Address;
  approvedRoot: bigint;
  version: bigint;
  updatedSlot: bigint;
  bump: number;
}

export function decodeApprovalState(data: Uint8Array): ApprovalStateAccount {
  const r = reader("ApprovalState", data, ACCOUNT_SIZES.ApprovalState);
  const out: ApprovalStateAccount = {
    pool: r.pubkey(),
    approvalAuthority: r.pubkey(),
    approvedRoot: fe(r),
    version: r.u64(),
    updatedSlot: r.u64(),
    bump: r.u8(),
  };
  r.end();
  return out;
}

// ---------------------------------------------------------------------------------------
// Events

export type PoolEvent =
  | { name: "PoolInitialized"; pool: Address; poolId: Uint8Array; mint: Address; tokenProgram: Address; vault: Address; genesisHash: Uint8Array; emptyRoot: bigint; configAuthority: Address; approvalAuthority: Address; protocolVersion: number }
  | { name: "DepositQueued"; pool: Address; queueSeq: bigint; amount: bigint; refundAuthority: Address; salt: Uint8Array; label: bigint; precommitment: bigint; commitment: bigint; liability: bigint }
  | { name: "DepositRefunded"; pool: Address; queueSeq: bigint; amount: bigint; refundAuthority: Address; destination: Address; liability: bigint }
  | { name: "LeafInserted"; pool: Address; queueSeq: bigint; kind: "deposit" | "change"; leafIndex: bigint; commitment: bigint; newRoot: bigint }
  | { name: "QueueItemSkipped"; pool: Address; queueSeq: bigint }
  | { name: "ApprovedRootUpdated"; pool: Address; version: bigint; approvedRoot: bigint }
  | { name: "PrivateSpend"; pool: Address; nullifierHash: bigint; stateRoot: bigint; approvedRoot: bigint; withdrawnValue: bigint; payoutAmount: bigint; relayerFee: bigint; destinationTokenAccount: Address; destinationOwner: Address; relayer: Address | null; validUntilSlot: bigint; newCommitment: bigint; changeQueueSeq: bigint; liability: bigint }
  | { name: "PublicExit"; pool: Address; nullifierHash: bigint; stateRoot: bigint; label: bigint; value: bigint; refundAuthority: Address; destination: Address; liability: bigint }
  | { name: "ConfigUpdated"; pool: Address; depositsPaused: boolean; minDeposit: bigint; maxDeposit: bigint; liabilityCap: bigint; maxRelayerFee: bigint };

export type PoolEventName = PoolEvent["name"];

const EVENT_DECODERS: { [K in PoolEventName]: (r: BorshReader) => Extract<PoolEvent, { name: K }> } = {
  PoolInitialized: (r) => ({
    name: "PoolInitialized",
    pool: r.pubkey(),
    poolId: r.bytes(32),
    mint: r.pubkey(),
    tokenProgram: r.pubkey(),
    vault: r.pubkey(),
    genesisHash: r.bytes(32),
    emptyRoot: fe(r),
    configAuthority: r.pubkey(),
    approvalAuthority: r.pubkey(),
    protocolVersion: r.u8(),
  }),
  DepositQueued: (r) => ({
    name: "DepositQueued",
    pool: r.pubkey(),
    queueSeq: r.u64(),
    amount: r.u64(),
    refundAuthority: r.pubkey(),
    salt: r.bytes(32),
    label: fe(r),
    precommitment: fe(r),
    commitment: fe(r),
    liability: r.u64(),
  }),
  DepositRefunded: (r) => ({
    name: "DepositRefunded",
    pool: r.pubkey(),
    queueSeq: r.u64(),
    amount: r.u64(),
    refundAuthority: r.pubkey(),
    destination: r.pubkey(),
    liability: r.u64(),
  }),
  LeafInserted: (r) => {
    const pool = r.pubkey();
    const queueSeq = r.u64();
    const k = r.u8();
    if (k !== 0 && k !== 1) throw new EncodingError("LeafInserted: unknown kind");
    return { name: "LeafInserted", pool, queueSeq, kind: k === 0 ? "deposit" : "change", leafIndex: r.u64(), commitment: fe(r), newRoot: fe(r) };
  },
  QueueItemSkipped: (r) => ({ name: "QueueItemSkipped", pool: r.pubkey(), queueSeq: r.u64() }),
  ApprovedRootUpdated: (r) => ({ name: "ApprovedRootUpdated", pool: r.pubkey(), version: r.u64(), approvedRoot: fe(r) }),
  PrivateSpend: (r) => ({
    name: "PrivateSpend",
    pool: r.pubkey(),
    nullifierHash: fe(r),
    stateRoot: fe(r),
    approvedRoot: fe(r),
    withdrawnValue: r.u64(),
    payoutAmount: r.u64(),
    relayerFee: r.u64(),
    destinationTokenAccount: r.pubkey(),
    destinationOwner: r.pubkey(),
    relayer: r.option((x) => x.pubkey()),
    validUntilSlot: r.u64(),
    newCommitment: fe(r),
    changeQueueSeq: r.u64(),
    liability: r.u64(),
  }),
  PublicExit: (r) => ({
    name: "PublicExit",
    pool: r.pubkey(),
    nullifierHash: fe(r),
    stateRoot: fe(r),
    label: fe(r),
    value: r.u64(),
    refundAuthority: r.pubkey(),
    destination: r.pubkey(),
    liability: r.u64(),
  }),
  ConfigUpdated: (r) => ({
    name: "ConfigUpdated",
    pool: r.pubkey(),
    depositsPaused: r.bool(),
    minDeposit: r.u64(),
    maxDeposit: r.u64(),
    liabilityCap: r.u64(),
    maxRelayerFee: r.u64(),
  }),
};

export const POOL_EVENTS = Object.keys(EVENT_DECODERS) as PoolEventName[];

const EVENT_BY_DISC = new Map(POOL_EVENTS.map((n) => [Buffer.from(eventDiscriminator(n)).toString("hex"), n]));

/** Decodes one `emit!` payload (8-byte discriminator + Borsh). Returns null for unknown events. */
export function decodePoolEvent(data: Uint8Array): PoolEvent | null {
  if (data.length < 8) return null;
  const name = EVENT_BY_DISC.get(Buffer.from(data.subarray(0, 8)).toString("hex"));
  if (name === undefined) return null;
  const r = new BorshReader(data.subarray(8));
  const ev = EVENT_DECODERS[name](r);
  r.end();
  return ev;
}

/** Encodes an event as the program would emit it (used for fixtures and replay tests). */
export function encodePoolEvent(ev: PoolEvent): Uint8Array {
  const w = new BorshWriter().bytes(eventDiscriminator(ev.name));
  const f = (x: bigint) => w.bytes(toBe32(x), 32);
  switch (ev.name) {
    case "PoolInitialized":
      w.pubkey(ev.pool).bytes(ev.poolId, 32).pubkey(ev.mint).pubkey(ev.tokenProgram).pubkey(ev.vault).bytes(ev.genesisHash, 32);
      f(ev.emptyRoot);
      w.pubkey(ev.configAuthority).pubkey(ev.approvalAuthority).u8(ev.protocolVersion);
      break;
    case "DepositQueued":
      w.pubkey(ev.pool).u64(ev.queueSeq).u64(ev.amount).pubkey(ev.refundAuthority).bytes(ev.salt, 32);
      f(ev.label);
      f(ev.precommitment);
      f(ev.commitment);
      w.u64(ev.liability);
      break;
    case "DepositRefunded":
      w.pubkey(ev.pool).u64(ev.queueSeq).u64(ev.amount).pubkey(ev.refundAuthority).pubkey(ev.destination).u64(ev.liability);
      break;
    case "LeafInserted":
      w.pubkey(ev.pool).u64(ev.queueSeq).u8(ev.kind === "deposit" ? 0 : 1).u64(ev.leafIndex);
      f(ev.commitment);
      f(ev.newRoot);
      break;
    case "QueueItemSkipped":
      w.pubkey(ev.pool).u64(ev.queueSeq);
      break;
    case "ApprovedRootUpdated":
      w.pubkey(ev.pool).u64(ev.version);
      f(ev.approvedRoot);
      break;
    case "PrivateSpend":
      w.pubkey(ev.pool);
      f(ev.nullifierHash);
      f(ev.stateRoot);
      f(ev.approvedRoot);
      w.u64(ev.withdrawnValue).u64(ev.payoutAmount).u64(ev.relayerFee).pubkey(ev.destinationTokenAccount).pubkey(ev.destinationOwner);
      w.option(ev.relayer, (x, v) => x.pubkey(v)).u64(ev.validUntilSlot);
      f(ev.newCommitment);
      w.u64(ev.changeQueueSeq).u64(ev.liability);
      break;
    case "PublicExit":
      w.pubkey(ev.pool);
      f(ev.nullifierHash);
      f(ev.stateRoot);
      f(ev.label);
      w.u64(ev.value).pubkey(ev.refundAuthority).pubkey(ev.destination).u64(ev.liability);
      break;
    case "ConfigUpdated":
      w.pubkey(ev.pool).bool(ev.depositsPaused).u64(ev.minDeposit).u64(ev.maxDeposit).u64(ev.liabilityCap).u64(ev.maxRelayerFee);
      break;
  }
  return w.finish();
}

/**
 * Extracts this program's events from a transaction's log messages. Only `Program data:`
 * lines emitted while `program` is the executing program are considered, so an event-shaped
 * log from another program (for example a CPI caller) cannot inject state.
 */
export function parsePoolEventsFromLogs(program: Address, logs: readonly string[]): PoolEvent[] {
  const stack: string[] = [];
  const events: PoolEvent[] = [];
  for (const line of logs) {
    const invoke = /^Program (\S+) invoke \[\d+\]$/.exec(line);
    if (invoke) {
      stack.push(invoke[1]!);
      continue;
    }
    if (/^Program (\S+) (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    const data = /^Program data: (\S+)$/.exec(line);
    if (data && stack[stack.length - 1] === program) {
      const ev = decodePoolEvent(new Uint8Array(Buffer.from(data[1]!, "base64")));
      if (ev) events.push(ev);
    }
  }
  return events;
}

// ---------------------------------------------------------------------------------------
// Account encoders (inverse of the decoders; used for fixtures and local test validators)

export function encodePoolState(a: PoolStateAccount): Uint8Array {
  const w = new BorshWriter().bytes(accountDiscriminator("PoolState"));
  w.u8(a.protocolVersion).u8(a.bump).u8(a.vaultAuthorityBump).u8(a.mintDecimals).bool(a.depositsPaused).u8(a.rootsLen).u8(a.rootsNext);
  w.bytes(a.poolId, 32).pubkey(a.mint).pubkey(a.tokenProgram).pubkey(a.vault).bytes(a.genesisHash, 32).pubkey(a.configAuthority);
  w.bytes(toBe32(a.currentRoot), 32);
  if (a.rootHistory.length !== 32) throw new EncodingError("root history must have 32 entries");
  for (const r of a.rootHistory) w.bytes(toBe32(r), 32);
  for (const v of [a.nextLeafIndex, a.queueHead, a.queueTail, a.liability, a.minDeposit, a.maxDeposit, a.liabilityCap, a.maxRelayerFee, a.cumulativeDeposited, a.cumulativeOutflow]) w.u64(v);
  return w.bytes(new Uint8Array(64)).finish();
}

export function encodeApprovalState(a: ApprovalStateAccount): Uint8Array {
  return new BorshWriter()
    .bytes(accountDiscriminator("ApprovalState"))
    .pubkey(a.pool)
    .pubkey(a.approvalAuthority)
    .bytes(toBe32(a.approvedRoot), 32)
    .u64(a.version)
    .u64(a.updatedSlot)
    .u8(a.bump)
    .finish();
}

export function encodeSpentNullifier(a: SpentNullifierAccount): Uint8Array {
  return new BorshWriter().bytes(accountDiscriminator("SpentNullifier")).pubkey(a.pool).u8(a.kind === "spend" ? 1 : 2).u64(a.slot).u8(a.bump).finish();
}
