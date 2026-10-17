import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { address, getAddressDecoder, getBase58Decoder, getCompiledTransactionMessageDecoder, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError, type Address } from "@solana/kit";
import { createServiceHealth, DEMO_TOKEN_MINT, DEVNET_CAIP2, DEVNET_GENESIS_HASH, loadConfig, type FundingBinding } from "@veilo/contracts";
import { PROTOTYPE_APPROVAL_RULE, withdrawalRequestWire, type PublicStateWire, type RecoveryRequestWire, type RecoveryViewWire, type WithdrawalRequestWire, type WithdrawalViewWire } from "@veilo/contracts/relayer";
import { openSecretsDatabase } from "@veilo/db";
import {
  accountDiscriminator,
  addressBytes,
  associatedTokenAddress,
  BorshWriter,
  buildApprovedTree,
  deriveLabel,
  getPoseidon,
  hexToBytes,
  MerkleTree,
  parseDecimal,
  poolStatePda,
  spentNullifierPda,
  toBe32,
  type CircuitWitness,
  type GeneratedProof,
  type Poseidon,
} from "@veilo/privacy-sdk";
import { decodeWireTransaction } from "@veilo/x402-client";
import { createApp as createControlApp } from "@veilo/control/src/app";
import { ServiceCredentials } from "@veilo/control/src/auth/credentials";
import { authorizePurchase } from "@veilo/control/src/ledger/authorize";
import { reservedNoteFor } from "@veilo/control/src/ledger/notes";
import { getPurchaseRow } from "@veilo/control/src/ledger/purchases";
import { activateDefaults, addService, createEnv, digest, type TestEnv } from "@veilo/control/test/helpers";
import { HttpControlPort, ServiceCallError } from "../src/adapters";
import type { MerchantSigner, WalletDeps } from "../src/deps";
import { FundingService, type FundingInput } from "../src/funding";
import { NoteService } from "../src/notes";
import { OwnerFlows } from "../src/owner-flows";
import type { PoolContext } from "../src/pool";
import { PortUnavailableError, type ChainPort, type ProverPort, type RelayerPort, type SignatureStatus } from "../src/ports";
import { ensureOwnerServiceSecret, WalletKeys } from "../src/secret";
import { WalletStore } from "../src/store";

export const WALLET_TOKEN = `wallet-service-token-${"x".repeat(32)}`;
const fill = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
export const randomAddress = (): Address => getAddressDecoder().decode(randomBytes(32));
export const randomSignature = (): string => getBase58Decoder().decode(randomBytes(64));

export async function testPoolContext(): Promise<PoolContext> {
  const programId = fill(0xaa);
  const poolState = (await poolStatePda(programId, new Uint8Array(32).fill(1))).address;
  return {
    programId,
    poolState,
    vault: fill(0x13),
    vaultAuthority: fill(0x14),
    approvalState: fill(0x15),
    mint: address(DEMO_TOKEN_MINT),
    genesisHash: hexToBytes("ce59db5080fc2c6d3bcf7ca90712d3c2e5e6c28f27f0dfbb9953bdb0894c03ab"),
    relayer: fill(0x77),
    sponsor: fill(0x77),
    maxIntentSlots: 750n,
  };
}

/** In-memory finalized chain view. Tests advance slot/height explicitly. */
export class FakeChain implements ChainPort {
  slot = 400_000_000n;
  height = 300_000_000n;
  accounts = new Map<string, { data: Uint8Array; lamports: bigint; owner: string }>();
  statuses = new Map<string, SignatureStatus>();
  balances = new Map<string, bigint>();
  validBlockhashes = new Set<string>();
  merchantTx = new Map<string, { signature: string; err: unknown; finalized: boolean }>();
  async finalizedSlot() {
    return this.slot;
  }
  async finalizedBlockHeight() {
    return this.height;
  }
  async latestBlockhash() {
    const blockhash = randomAddress() as string;
    this.validBlockhashes.add(blockhash);
    return { blockhash, lastValidBlockHeight: this.height + 150n };
  }
  async account(addr: Address) {
    return this.accounts.get(addr) ?? null;
  }
  async tokenBalance(ata: Address) {
    return this.balances.get(ata) ?? null;
  }
  async signatureStatus(sig: string) {
    return this.statuses.get(sig) ?? null;
  }
  async isBlockhashValid(bh: string) {
    return this.validBlockhashes.has(bh);
  }
  async findTransaction(_addr: Address, messageHash: string) {
    return this.merchantTx.get(messageHash) ?? null;
  }
  finalize(sig: string, err: unknown = null) {
    this.statuses.set(sig, { confirmationStatus: "finalized", err, slot: this.slot });
  }
}

function encodePoolState(f: { root: bigint; roots: bigint[]; next: bigint; head: bigint; tail: bigint; liability: bigint; mint: Address; vault: Address }): Uint8Array {
  const w = new BorshWriter().bytes(accountDiscriminator("PoolState"));
  w.u8(1).u8(255).u8(255).u8(6).bool(false).u8(f.roots.length).u8(f.roots.length % 32).bytes(new Uint8Array(32).fill(1));
  w.pubkey(f.mint).pubkey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").pubkey(f.vault);
  w.bytes(hexToBytes("ce59db5080fc2c6d3bcf7ca90712d3c2e5e6c28f27f0dfbb9953bdb0894c03ab"), 32).pubkey(fill(0x21)).bytes(toBe32(f.root), 32);
  for (let i = 0; i < 32; i++) w.bytes(toBe32(f.roots[i] ?? 0n), 32);
  w.u64(f.next).u64(f.head).u64(f.tail).u64(f.liability).u64(100_000n).u64(20_000_000n).u64(100_000_000n).u64(0n).u64(0n).u64(0n);
  w.bytes(new Uint8Array(64));
  return w.finish();
}

function encodeApprovalState(pool: Address, root: bigint, version: bigint): Uint8Array {
  return new BorshWriter().bytes(accountDiscriminator("ApprovalState")).pubkey(pool).pubkey(fill(0x22)).bytes(toBe32(root), 32).u64(version).u64(1n).u8(255).finish();
}

function encodeSpentNullifier(pool: Address, kind: 1 | 2): Uint8Array {
  return new BorshWriter().bytes(accountDiscriminator("SpentNullifier")).pubkey(pool).u8(kind).u64(1n).u8(255).finish();
}

/** Simulated pool program: authenticated queue, tree, approved root and nullifiers. */
export class FakePool {
  tree: MerkleTree;
  roots: bigint[];
  deposits = new Map<bigint, { queueSeq: bigint; commitment: bigint; label: bigint; amount: bigint; refundAuthority: Address; state: "pending" | "inserted" | "refunded" | "skipped"; leafIndex: number | null }>();
  changes = new Map<bigint, { commitment: bigint; nullifierHash: bigint; state: "pending" | "inserted" }>();
  leaves: PublicStateWire["leaves"] = [];
  spends: PublicStateWire["spends"] = [];
  exits: PublicStateWire["exits"] = [];
  approved: bigint[] = [];
  approvedVersion = 0n;
  head = 0n;
  tail = 0n;
  liability = 0n;

  constructor(
    readonly p: Poseidon,
    readonly ctx: PoolContext,
    readonly chain: FakeChain,
  ) {
    this.tree = new MerkleTree(p);
    this.roots = [this.tree.root];
    this.publish();
  }

  publish(): void {
    this.chain.accounts.set(this.ctx.poolState, {
      data: encodePoolState({ root: this.tree.root, roots: this.roots, next: BigInt(this.tree.size), head: this.head, tail: this.tail, liability: this.liability, mint: this.ctx.mint, vault: this.ctx.vault }),
      lamports: 1n,
      owner: this.ctx.programId,
    });
    this.chain.accounts.set(this.ctx.approvalState, { data: encodeApprovalState(this.ctx.poolState, buildApprovedTree(this.p, this.approved).root, this.approvedVersion), lamports: 1n, owner: this.ctx.programId });
  }

  deposit(d: { amount: bigint; label: bigint; precommitment: bigint; refundAuthority: Address }): bigint {
    const seq = this.tail++;
    this.deposits.set(seq, { queueSeq: seq, commitment: this.p.h3(d.amount, d.label, d.precommitment), label: d.label, amount: d.amount, refundAuthority: d.refundAuthority, state: "pending", leafIndex: null });
    this.liability += d.amount;
    this.publish();
    return seq;
  }

  insertAll(): void {
    while (this.head < this.tail) {
      const d = this.deposits.get(this.head);
      const c = this.changes.get(this.head);
      const rec = d ?? c!;
      if (rec.state === "pending") {
        const index = this.tree.append(rec.commitment);
        rec.state = "inserted";
        if (d) d.leafIndex = index;
        this.leaves.push({ index, commitment: rec.commitment.toString(), kind: d ? "deposit" : "change", queueSeq: this.head.toString() });
        this.roots.push(this.tree.root);
        if (this.roots.length > 32) this.roots.shift();
      } else if (d && d.state === "refunded") d.state = "skipped";
      this.head++;
    }
    this.publish();
  }

  approve(label: bigint): void {
    if (!this.approved.includes(label)) this.approved.push(label);
    this.approvedVersion++;
    this.publish();
  }

  async spend(s: { nullifierHash: bigint; newCommitment: bigint; withdrawn: bigint; destinationOwner: string }): Promise<void> {
    const pda = await spentNullifierPda(this.ctx.programId, this.ctx.poolState, toBe32(s.nullifierHash));
    if (this.chain.accounts.has(pda.address)) throw new Error("nullifier already spent");
    this.chain.accounts.set(pda.address, { data: encodeSpentNullifier(this.ctx.poolState, 1), lamports: 1n, owner: this.ctx.programId });
    const seq = this.tail++;
    this.changes.set(seq, { commitment: s.newCommitment, nullifierHash: s.nullifierHash, state: "pending" });
    this.spends.push({ nullifierHash: s.nullifierHash.toString(), newCommitment: s.newCommitment.toString(), withdrawnValue: s.withdrawn.toString(), destinationOwner: address(s.destinationOwner), changeQueueSeq: seq.toString() });
    this.liability -= s.withdrawn;
    this.publish();
  }

  async exit(nullifierHash: bigint, label: bigint, value: bigint): Promise<void> {
    const pda = await spentNullifierPda(this.ctx.programId, this.ctx.poolState, toBe32(nullifierHash));
    this.chain.accounts.set(pda.address, { data: encodeSpentNullifier(this.ctx.poolState, 2), lamports: 1n, owner: this.ctx.programId });
    this.exits.push({ nullifierHash: nullifierHash.toString(), label: label.toString(), value: value.toString() });
    this.liability -= value;
    this.publish();
  }

  view(): PublicStateWire {
    return {
      finalizedSlot: this.chain.slot.toString(),
      consistent: true,
      mismatches: [],
      pool: {
        poolState: this.ctx.poolState,
        currentRoot: this.tree.root.toString(),
        knownRoots: this.roots.map(String),
        nextLeafIndex: String(this.tree.size),
        queueHead: this.head.toString(),
        queueTail: this.tail.toString(),
        liability: this.liability.toString(),
        minDeposit: "100000",
        maxDeposit: "20000000",
        maxRelayerFee: "0",
        depositsPaused: false,
      },
      leaves: [...this.leaves],
      deposits: [...this.deposits.values()].map((d) => ({ queueSeq: d.queueSeq.toString(), commitment: d.commitment.toString(), label: d.label.toString(), amount: d.amount.toString(), refundAuthority: d.refundAuthority, state: d.state, leafIndex: d.leafIndex })),
      spends: [...this.spends],
      exits: [...this.exits],
      approved: { root: buildApprovedTree(this.p, this.approved).root.toString(), version: this.approvedVersion.toString(), labels: this.approved.map(String), consistent: true, rule: PROTOTYPE_APPROVAL_RULE },
    };
  }
}

/** "error_unrecorded": the relayer fails (HTTP 5xx) before it persists anything. */
export type RelayerMode = "land" | "hold" | "lose_response" | "down" | "error_unrecorded";

/** Relayer double. Enforces the strict wire schema and keeps every request body for inspection. */
export class FakeRelayer implements RelayerPort {
  mode: RelayerMode = "land";
  received: string[] = [];
  withdrawals = new Map<string, WithdrawalViewWire>();
  recoveries = new Map<string, { req: RecoveryRequestWire; view: RecoveryViewWire }>();

  constructor(
    readonly pool: FakePool,
    readonly chain: FakeChain,
  ) {}

  async deployment(): Promise<never> {
    throw new Error("not used: tests inject the pool context");
  }
  async publicState() {
    return this.pool.view();
  }
  async submitWithdrawal(req: WithdrawalRequestWire): Promise<WithdrawalViewWire> {
    if (this.mode === "down") throw new PortUnavailableError("relayer unreachable (test)");
    const parsed = withdrawalRequestWire.parse(JSON.parse(JSON.stringify(req)));
    this.received.push(JSON.stringify(req));
    if (this.mode === "error_unrecorded") throw new ServiceCallError(503, "INTERNAL_ERROR", "relayer: chain read failed before the request was recorded (test)");
    const existing = this.withdrawals.get(parsed.withdrawalId);
    if (existing) return existing;
    const signature = randomSignature();
    const view: WithdrawalViewWire = {
      withdrawalId: parsed.withdrawalId,
      state: "submitted",
      nullifierHash: parsed.publicSignals[3]!,
      validUntilSlot: parsed.intent.validUntilSlot,
      ataSignature: null,
      signature,
      blockhash: null,
      lastValidBlockHeight: null,
      sponsorFeeLamports: "10000",
      sponsorRentLamports: "2039280",
      finalizedSlot: null,
      error: null,
    };
    this.withdrawals.set(parsed.withdrawalId, view);
    if (this.mode === "land" || this.mode === "lose_response") await this.land(parsed, signature);
    if (this.mode === "lose_response") throw new PortUnavailableError("reply lost (test)");
    return view;
  }
  async land(req: WithdrawalRequestWire, signature: string): Promise<void> {
    const ps = req.publicSignals.map(parseDecimal);
    await this.pool.spend({ nullifierHash: ps[3]!, newCommitment: ps[5]!, withdrawn: ps[4]!, destinationOwner: req.intent.destinationOwner });
    this.chain.finalize(signature);
    this.chain.balances.set(req.intent.destinationTokenAccount, BigInt(req.intent.payoutAmount));
    this.chain.accounts.set(req.intent.destinationTokenAccount, { data: new Uint8Array(165), lamports: 2_039_280n, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" });
    const v = this.withdrawals.get(req.withdrawalId)!;
    this.withdrawals.set(req.withdrawalId, { ...v, state: "finalized", finalizedSlot: this.chain.slot.toString() });
  }
  async withdrawal(id: string) {
    if (this.mode === "down") throw new PortUnavailableError("relayer unreachable (test)");
    return this.withdrawals.get(id) ?? null;
  }
  async submitRecovery(req: RecoveryRequestWire): Promise<RecoveryViewWire> {
    this.received.push(JSON.stringify(req));
    const view: RecoveryViewWire = { recoveryId: req.recoveryId, state: "submitted", signature: randomSignature(), blockhash: "x", lastValidBlockHeight: req.lastValidBlockHeight, sponsorFeeLamports: "5000", rentRecoveredLamports: "0", error: null };
    this.recoveries.set(req.recoveryId, { req, view });
    return view;
  }
  async recovery(id: string) {
    return this.recoveries.get(id)?.view ?? null;
  }
}

/** Orchestration tests use the witness's public signals with a placeholder proof; real proving is covered separately. */
export const placeholderProver: ProverPort & { calls: number } = {
  calls: 0,
  async prove(_c: "spend" | "exit", w: CircuitWitness): Promise<GeneratedProof> {
    this.calls++;
    const one = ["1", "2", "1"];
    return { proof: { pi_a: one, pi_b: [["1", "2"], ["3", "4"], ["1", "0"]], pi_c: one, protocol: "groth16", curve: "bn128" }, publicSignals: w.publicSignals.map(String) };
  },
};

/**
 * Injected failures, one per sign call: "rpc_429" fails like the SDK's mint read before any
 * signature; "after_sign" fails after the fresh wallet signed; "policy" is a non-RPC refusal.
 */
export type MerchantFault = "rpc_429" | "after_sign" | "policy";

export function fakeMerchant(): MerchantSigner & { calls: number; signatures: number; blockhash: string; faults: MerchantFault[] } {
  const m = {
    calls: 0,
    signatures: 0,
    faults: [] as MerchantFault[],
    async sign({ wallet, purchaseRef }: Parameters<MerchantSigner["sign"]>[0]) {
      m.calls++;
      const fault = m.faults.shift();
      if (fault === "rpc_429") {
        throw new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers({ "x-api-key": "secret-header" }), message: "Too Many Requests", statusCode: 429 });
      }
      if (fault === "policy") throw new Error("challenge does not match the approved binding");
      const messageBytes = new Uint8Array(randomBytes(96));
      const sig = await wallet.signPaymentMessage({ purchaseRef, messageBytes, validated: {} as never });
      m.signatures++;
      if (fault === "after_sign") throw new TypeError("fetch failed");
      return {
        paymentSignatureHeader: Buffer.from(sig).toString("base64"),
        messageHash: createHash("sha256").update(messageBytes).digest("base64"),
        recentBlockhash: m.blockhash,
      };
    },
    blockhash: "11111111111111111111111111111111" as string,
  };
  return m;
}

export interface ControlHarness {
  env: TestEnv;
  base: string;
  server: Server;
  serviceId: string;
  close(): void;
}

export async function startControl(): Promise<ControlHarness> {
  const env = createEnv();
  activateDefaults(env);
  const serviceId = addService(env, [{ sku: "research-basic", paymentPath: "private_x402", price: 100_000n, lamports: 3_000_000n }]);
  const config = loadConfig({ DEVNET_RPC_URL: "https://rpc.test.invalid", EXPECTED_DEVNET_GENESIS_HASH: DEVNET_GENESIS_HASH, DEMO_TOKEN_MINT, FACILITATOR_URL: "https://facilitator.payai.network" });
  const app = createControlApp(createServiceHealth("control", config, false), {
    ledger: env.ledger,
    session: { domain: "localhost:3000", origin: "http://localhost:3000", chainId: DEVNET_CAIP2, challengeTtlMs: 60_000, sessionTtlMs: 3_600_000, secureCookies: false },
    services: new ServiceCredentials([{ service: "wallet", secret: WALLET_TOKEN }]),
    log: () => undefined,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  return { env, base: `http://127.0.0.1:${port}`, server, serviceId, close: () => (server.close(), env.cleanup()) };
}

export interface TestWallet {
  store: WalletStore;
  deps: WalletDeps;
  funding: FundingService;
  notes: NoteService;
  owner: OwnerFlows;
  keys: WalletKeys;
  close(): void;
}

export interface World {
  dir: string;
  p: Poseidon;
  ctx: PoolContext;
  chain: FakeChain;
  pool: FakePool;
  relayer: FakeRelayer;
  control: ControlHarness;
  merchant: ReturnType<typeof fakeMerchant>;
  recoveryOwner: Address;
  open(): TestWallet;
  cleanup(): void;
}

export async function createWorld(): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "veilo-wallet-"));
  const p = await getPoseidon();
  const ctx = await testPoolContext();
  const chain = new FakeChain();
  const pool = new FakePool(p, ctx, chain);
  const relayer = new FakeRelayer(pool, chain);
  const control = await startControl();
  const merchant = fakeMerchant();
  const recoveryOwner = randomAddress();
  const opened: TestWallet[] = [];
  const world: World = {
    dir,
    p,
    ctx,
    chain,
    pool,
    relayer,
    control,
    merchant,
    recoveryOwner,
    open() {
      const keyPath = join(dir, "owner-service.secret");
      ensureOwnerServiceSecret(keyPath);
      const keys = WalletKeys.fromFile(keyPath);
      const db = openSecretsDatabase(join(dir, "wallet-secrets.sqlite"), { controlDatabasePath: control.env.dbPath });
      const store = new WalletStore(db, keys);
      const deps: WalletDeps = {
        store,
        poseidon: p,
        control: new HttpControlPort(control.base, WALLET_TOKEN),
        relayer,
        chain,
        prover: placeholderProver,
        merchant,
        pool: async () => ctx,
        ownerRecoveryAddress: recoveryOwner,
      };
      const funding = new FundingService(deps);
      const w: TestWallet = { store, deps, funding, notes: new NoteService(deps), owner: new OwnerFlows(deps, funding), keys, close: () => db.close() };
      opened.push(w);
      return w;
    },
    cleanup() {
      for (const w of opened) {
        try {
          w.close();
        } catch {
          /* already closed */
        }
      }
      control.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return world;
}

/** Reads amount/precommitment/salt back out of the unsigned deposit transaction the wallet built. */
export function decodeDepositTx(wire: string, programId: Address): { amount: bigint; precommitment: bigint; salt: Uint8Array } {
  const tx = decodeWireTransaction(wire);
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const ix = msg.instructions.find((i) => msg.staticAccounts[i.programAddressIndex] === programId)!;
  const data = new Uint8Array(ix.data!);
  return {
    amount: new DataView(data.buffer, data.byteOffset).getBigUint64(8, true),
    precommitment: BigInt(`0x${Buffer.from(data.subarray(16, 48)).toString("hex")}`),
    salt: data.slice(48, 80),
  };
}

/** Owner deposits `amount`; the pool queues, inserts and approves it; the wallet syncs to spendable. */
export async function depositAndApprove(world: World, w: TestWallet, amount: bigint, approve = true): Promise<string> {
  const owner = address(world.control.env.owner.address);
  const prep = await w.notes.prepareDeposit(owner, amount);
  const d = decodeDepositTx(prep.transaction, world.ctx.programId);
  const label = deriveLabel({ pool: addressBytes(world.ctx.poolState), mint: addressBytes(world.ctx.mint), refundAuthority: addressBytes(owner), salt: d.salt }).label;
  w.notes.registerDeposit(owner, prep.depositId, randomSignature());
  world.pool.deposit({ amount: d.amount, label, precommitment: d.precommitment, refundAuthority: owner });
  world.pool.insertAll();
  if (approve) world.pool.approve(label);
  await w.notes.sync();
  return prep.depositId;
}

export const BINDING: FundingBinding = {
  origin: "http://127.0.0.1:4104",
  gatewayIdentity: "gw",
  sku: "research-basic",
  network: DEVNET_CAIP2,
  mint: DEMO_TOKEN_MINT,
  payTo: "Recipient1111",
  merchantAta: "Ata1111",
  allowedFeePayers: ["2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4"],
};

/** A worker-authorized purchase (control reserves the smallest covering note). */
export function authorize(world: World, key: string, agent: "Prince" | "Mira" = "Prince") {
  const { env, serviceId } = world.control;
  const r = authorizePurchase(env.ledger, {
    workspaceId: env.ws.id,
    agentId: env.agents[agent].id,
    idempotencyKey: key,
    serviceId,
    sku: "research-basic",
    paymentPath: "private_x402",
    requestDigest: digest(key),
  });
  return r.purchase;
}

export function fundingInput(world: World, purchaseId: string): FundingInput {
  const p = getPurchaseRow(world.control.env.ledger, purchaseId);
  const note = reservedNoteFor(world.control.env.ledger, purchaseId)!;
  return {
    purchaseId,
    operationId: p.operation_id,
    payoutUsdc: p.price_usdc,
    tokenFeeCapUsdc: p.fee_cap_usdc,
    sponsorLamportCap: p.sponsor_lamports,
    inputNote: { commitment: note.commitment, value: note.value },
    binding: BINDING,
  };
}

export async function freshAta(world: World, owner: string): Promise<Address> {
  return (await associatedTokenAddress(address(owner), world.ctx.mint)).address;
}
