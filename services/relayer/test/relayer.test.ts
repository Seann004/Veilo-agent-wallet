import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPair,
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
} from "@solana/kit";
import { getCloseAccountInstruction, getTransferCheckedInstruction } from "@solana-program/token";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServiceHealth, DEMO_TOKEN_MINT, DEVNET_GENESIS_HASH, loadConfig } from "@veilo/contracts";
import { createHash } from "node:crypto";
import type { WithdrawalRequestWire } from "@veilo/contracts/relayer";
import {
  addressBytes,
  associatedTokenAddress,
  buildApprovedTree,
  commitment,
  deriveLabel,
  encodePoolEvent,
  hexToBytes,
  instructionDiscriminator,
  intentContext,
  MerkleTree,
  precommitment,
  prove,
  spentNullifierPda,
  toBe32,
  spendWitness,
  type DeploymentManifest,
  type PoolEvent,
  type Poseidon,
} from "@veilo/privacy-sdk";
import { decodeWireTransaction } from "@veilo/x402-client";
import { createApp } from "../src/app";
import { openRelayerDb, sponsorTotals } from "../src/db";
import { verifyDeployment } from "../src/deployment";
import { Indexer, IndexerError } from "../src/indexer";
import { RecoveryService, RelayerError, WithdrawalService } from "../src/withdrawals";
import type { SponsorKey } from "../src/sponsor";
import { BUILD, circuitPins, FakeRelayerChain, GENESIS_HEX, HAVE_CIRCUITS, poseidon, publishPool, randomAddress, spendVk, testManifest, testSponsor } from "./fixtures";

let p: Poseidon;
let dir: string;
beforeAll(async () => {
  p = await poseidon();
});
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const logsFor = (program: Address, ev: PoolEvent) => [`Program ${program} invoke [1]`, `Program data: ${Buffer.from(encodePoolEvent(ev)).toString("base64")}`, `Program ${program} success`];

describe("indexer replay (GET /public-state source)", () => {
  async function setup() {
    dir = mkdtempSync(join(tmpdir(), "veilo-relayer-"));
    const sponsor = await testSponsor();
    const m = await testManifest(sponsor.address);
    const chain = new FakeRelayerChain();
    const program = address(m.program.programId);
    const pool = address(m.pool.poolState);
    const tree = new MerkleTree(p);
    const empty = tree.root;
    const label = 4242n;
    const pre = p.h2(11n, 22n);
    const c = p.h3(500_000n, label, pre);
    tree.append(c);
    const approvedRoot = buildApprovedTree(p, [label]).root;
    const events: PoolEvent[] = [
      { name: "PoolInitialized", pool, poolId: new Uint8Array(32).fill(1), mint: address(DEMO_TOKEN_MINT), tokenProgram: address(m.token.tokenProgram), vault: address(m.pool.vault), genesisHash: hexToBytes(GENESIS_HEX), emptyRoot: empty, configAuthority: randomAddress(), approvalAuthority: randomAddress(), protocolVersion: 1 },
      { name: "DepositQueued", pool, queueSeq: 0n, amount: 500_000n, refundAuthority: randomAddress(), salt: new Uint8Array(32), label, precommitment: pre, commitment: c, liability: 500_000n },
      { name: "LeafInserted", pool, queueSeq: 0n, kind: "deposit", leafIndex: 0n, commitment: c, newRoot: tree.root },
      { name: "ApprovedRootUpdated", pool, version: 1n, approvedRoot },
    ];
    for (const ev of events) chain.addTx(pool, logsFor(program, ev));
    // A failed transaction with event-shaped logs must not contribute state.
    chain.addTx(pool, logsFor(program, { name: "DepositQueued", pool, queueSeq: 1n, amount: 1n, refundAuthority: randomAddress(), salt: new Uint8Array(32), label: 1n, precommitment: 1n, commitment: p.h3(1n, 1n, 1n), liability: 500_001n }), { InstructionError: [0, "x"] });
    publishPool(chain, m, { tree, roots: [empty, tree.root], approvedRoot, approvedVersion: 1n, head: 1n, tail: 1n, liability: 500_000n });
    const labelsPath = join(dir, "approved-labels.json");
    writeFileSync(labelsPath, JSON.stringify({ schema: "veilo-approved-labels-v1", pool, rule: "test rule", labels: [label.toString()], root: approvedRoot.toString() }));
    const db = openRelayerDb(":memory:");
    return { m, chain, tree, empty, approvedRoot, indexer: new Indexer(db, chain, p, program, pool, address(m.pool.approvalState), labelsPath) };
  }

  it("rebuilds the commitment and approved trees and matches the finalized accounts", async () => {
    const s = await setup();
    const { view } = await s.indexer.replay();
    expect(view.consistent).toBe(true);
    expect(view.leaves).toHaveLength(1);
    expect(view.deposits).toHaveLength(1);
    expect(view.approved).toMatchObject({ consistent: true, labels: ["4242"], version: "1" });
    expect(view.pool.currentRoot).toBe(s.tree.root.toString());
  });

  it("refuses to serve state when the on-chain root differs from the replay", async () => {
    const s = await setup();
    const forged = new MerkleTree(p);
    forged.append(77n);
    publishPool(s.chain, s.m, { tree: forged, roots: [s.empty, forged.root], approvedRoot: s.approvedRoot, approvedVersion: 1n, head: 1n, tail: 1n, liability: 500_000n });
    await expect(s.indexer.replay()).rejects.toThrow(IndexerError);
  });

  it("does not serve approved paths when the published labels disagree with the on-chain approved root", async () => {
    const s = await setup();
    publishPool(s.chain, s.m, { tree: s.tree, roots: [s.empty, s.tree.root], approvedRoot: s.approvedRoot, approvedVersion: 1n, head: 1n, tail: 1n, liability: 500_000n });
    writeFileSync(join(dir, "approved-labels.json"), JSON.stringify({ schema: "veilo-approved-labels-v1", pool: s.m.pool.poolState, rule: "r", labels: ["999"], root: "0" }));
    const { view } = await s.indexer.replay();
    expect(view.approved.consistent).toBe(false);
    expect(view.approved.labels).toEqual([]);
  });
});

interface SpendCase {
  m: DeploymentManifest;
  chain: FakeRelayerChain;
  sponsor: SponsorKey;
  req: WithdrawalRequestWire;
  svc: WithdrawalService;
  destAta: Address;
  /** A new attempt for the same note: new fresh destination, change secrets and slot bound. */
  reprove(withdrawalId: string, validUntilSlot: bigint): Promise<WithdrawalRequestWire>;
}

async function realSpend(): Promise<SpendCase> {
  const sponsor = await testSponsor();
  const m = await testManifest(sponsor.address);
  const chain = new FakeRelayerChain();
  const pool = address(m.pool.poolState);
  const owner = randomAddress();
  const label = deriveLabel({ pool: addressBytes(pool), mint: addressBytes(m.token.mint), refundAuthority: addressBytes(owner), salt: new Uint8Array(32).fill(5) }).label;
  const note = { value: 1_000_000n, label, nullifierSecret: 123456789n, noteSecret: 987654321n };
  const tree = new MerkleTree(p);
  const empty = tree.root;
  tree.append(p.h3(1n, 2n, 3n));
  tree.append(commitment(p, note));
  const approved = buildApprovedTree(p, [label]);
  publishPool(chain, m, { tree, roots: [empty, tree.root], approvedRoot: approved.root, approvedVersion: 1n, head: 2n, tail: 2n, liability: 1_000_001n });
  const pins = circuitPins();
  let changeSecret = 555n;
  const build = async (withdrawalId: string, validUntilSlot: bigint, destOwner: Address): Promise<{ req: WithdrawalRequestWire; destAta: Address }> => {
    const destAta = (await associatedTokenAddress(destOwner, address(m.token.mint))).address;
    const intent = { destinationTokenAccount: destAta, destinationOwner: destOwner, payoutAmount: "100000", relayerFee: "0", relayer: sponsor.address, relayerFeeTokenAccount: null, validUntilSlot: validUntilSlot.toString() };
    const ctx = intentContext(
      { programId: addressBytes(m.program.programId), pool: addressBytes(pool), genesisHash: hexToBytes(GENESIS_HEX), mint: addressBytes(m.token.mint) },
      { destinationTokenAccount: addressBytes(destAta), destinationOwner: addressBytes(destOwner), payoutAmount: 100_000n, relayerFee: 0n, relayer: addressBytes(sponsor.address), relayerFeeTokenAccount: null, validUntilSlot },
    );
    const w = spendWitness(p, { note, statePath: tree.path(1), approvedPath: approved.path(0), context: ctx.context, withdrawnValue: 100_000n, change: { nullifierSecret: changeSecret++, noteSecret: 666n } });
    const proved = await prove(w, { wasmPath: join(BUILD, "spend", "spend_js", "spend.wasm"), wasmSha256: pins.spend.wasmSha256, zkeyPath: join(BUILD, "zkey", "spend_final.zkey"), zkeySha256: pins.spend.zkeySha256 });
    return { req: { withdrawalId, proof: proved.proof as never, publicSignals: proved.publicSignals, intent, sponsorLamportCap: "5200000" }, destAta };
  };
  const first = await build("6f1c1b7e-0000-4000-8000-000000000001", chain.slot + 750n, randomAddress());
  const db = openRelayerDb(":memory:");
  chain.db = db;
  const svc = new WithdrawalService({ db, chain, sponsor, manifest: () => m, spendVk: spendVk(), sponsorCapLamports: 100_000_000n });
  void precommitment;
  return { m, chain, sponsor, req: first.req, svc, destAta: first.destAta, reprove: async (id, bound) => (await build(id, bound, randomAddress())).req };
}

describe.skipIf(!HAVE_CIRCUITS)("POST /withdrawals with a real spend proof (requires circuits/build)", () => {
  it("rejects bad material before spending sponsor funds", async () => {
    const s = await realSpend();
    const ctx = BigInt(s.req.publicSignals[0]!);
    await expect(s.svc.submit({ ...s.req, withdrawalId: "6f1c1b7e-0000-4000-8000-000000000002", publicSignals: [(ctx + 1n).toString(), ...s.req.publicSignals.slice(1)] })).rejects.toMatchObject({ code: "POLICY_DENIED" });
    const badProof = { ...(s.req.proof as { pi_a: string[] }), pi_a: [(s.req.proof as { pi_c: string[] }).pi_c[0]!, (s.req.proof as { pi_c: string[] }).pi_c[1]!, "1"] };
    await expect(s.svc.submit({ ...s.req, withdrawalId: "6f1c1b7e-0000-4000-8000-000000000003", proof: badProof as never })).rejects.toThrow(/does not verify/);
    await expect(s.svc.submit({ ...s.req, withdrawalId: "6f1c1b7e-0000-4000-8000-000000000004", sponsorLamportCap: "1000" })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    // ATA rent 2,039,280 + nullifier and change account rent 3,034,560 + two fees: the old estimate covered only the ATA.
    await expect(s.svc.submit({ ...s.req, withdrawalId: "6f1c1b7e-0000-4000-8000-000000000006", sponsorLamportCap: "5083839" })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    await expect(s.svc.submit({ ...s.req, withdrawalId: "6f1c1b7e-0000-4000-8000-000000000005", intent: { ...s.req.intent, relayer: randomAddress() } })).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(s.chain.sent).toHaveLength(0);
  }, 30_000);

  it("creates the fresh ATA in a separate sponsor transaction, persists every signature before sending, and tracks sponsor lamports", async () => {
    const s = await realSpend();
    const v1 = await s.svc.submit(s.req);
    expect(v1.state).toBe("ata_submitted");
    expect(s.chain.sent).toHaveLength(1);
    expect(s.chain.sent[0]!.persistedSignatures).toContain(v1.ataSignature);
    // Idempotent by withdrawal id; different material under the same id conflicts.
    expect((await s.svc.submit(s.req)).withdrawalId).toBe(s.req.withdrawalId);
    await expect(s.svc.submit({ ...s.req, sponsorLamportCap: "5199999" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    s.chain.accounts.set(s.destAta, { data: new Uint8Array(165), lamports: 2_039_280n, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", executable: false });
    s.chain.txs.set(v1.ataSignature!, { slot: 1n, err: null, logs: [], fee: 5000n });
    await s.svc.advance(s.req.withdrawalId);
    const v2 = s.svc.view(s.req.withdrawalId)!;
    expect(v2.state).toBe("submitted");
    expect(s.chain.sent[1]!.persistedSignatures).toContain(v2.signature);
    const msg = getCompiledTransactionMessageDecoder().decode(decodeWireTransaction(s.chain.sent[1]!.wire).messageBytes);
    expect(msg.staticAccounts[0]).toBe(s.sponsor.address);
    const spendIx = msg.instructions.find((i) => msg.staticAccounts[i.programAddressIndex] === s.m.program.programId)!;
    expect(Array.from(new Uint8Array(spendIx.data!).subarray(0, 8))).toEqual(Array.from(instructionDiscriminator("spend_private")));

    s.chain.statuses.set(v2.signature!, { confirmationStatus: "finalized", err: null });
    s.chain.txs.set(v2.signature!, { slot: 9n, err: null, logs: [], fee: 5000n });
    await s.svc.advance(s.req.withdrawalId);
    const v3 = s.svc.view(s.req.withdrawalId)!;
    expect(v3).toMatchObject({ state: "finalized", sponsorFeeLamports: "10000", sponsorRentLamports: "5073840" });
    expect(sponsorTotals(s.chain.db!).rentOutstanding).toBe(5_073_840n);
  }, 30_000);

  it("resubmits after a proven-expired attempt only while the intent bound allows", async () => {
    const s = await realSpend();
    s.chain.accounts.set(s.destAta, { data: new Uint8Array(165), lamports: 2_039_280n, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", executable: false });
    const v = await s.svc.submit(s.req);
    expect(v.state).toBe("submitted");
    s.chain.height += 151n;
    await s.svc.advance(s.req.withdrawalId);
    const v2 = s.svc.view(s.req.withdrawalId)!;
    expect(v2.signature).not.toBe(v.signature);
    s.chain.height += 151n;
    s.chain.slot += 751n;
    await s.svc.advance(s.req.withdrawalId);
    expect(s.svc.view(s.req.withdrawalId)!.state).toBe("expired");
  }, 30_000);

  it("records the request before any chain read; a failed read leaves it recorded and unchecked, and advance completes it", async () => {
    const s = await realSpend();
    const realSlot = s.chain.finalizedSlot.bind(s.chain);
    let recordedBeforeRead: boolean | null = null;
    s.chain.finalizedSlot = async () => {
      recordedBeforeRead = s.svc.view(s.req.withdrawalId) !== null;
      throw new Error("HTTP 429 Too Many Requests");
    };
    const v = await s.svc.submit(s.req);
    expect(recordedBeforeRead).toBe(true);
    expect(v.state).toBe("accepted");
    expect(v.error).toMatch(/chain checks pending/);
    expect(s.chain.sent).toHaveLength(0);
    // The identical resend is idempotent; nothing is sent until the chain checks pass.
    expect((await s.svc.submit(s.req)).state).toBe("accepted");
    expect(s.chain.sent).toHaveLength(0);
    s.chain.finalizedSlot = realSlot;
    expect(s.svc.pendingIds()).toContain(s.req.withdrawalId);
    await s.svc.advance(s.req.withdrawalId);
    expect(s.svc.view(s.req.withdrawalId)!.state).toBe("ata_submitted");
    expect(s.chain.sent).toHaveLength(1);
  }, 30_000);

  it("an identical request rejected before anything was sent is checked again when resubmitted", async () => {
    const s = await realSpend();
    const approval = s.chain.accounts.get(s.m.pool.approvalState)!;
    const stale = new Uint8Array(approval.data);
    stale[8 + 64] = stale[8 + 64]! ^ 1;
    s.chain.accounts.set(s.m.pool.approvalState, { ...approval, data: stale });
    await expect(s.svc.submit(s.req)).rejects.toMatchObject({ code: "NOTE_PENDING" });
    expect(s.svc.view(s.req.withdrawalId)!.state).toBe("rejected");
    expect(s.chain.sent).toHaveLength(0);
    s.chain.accounts.set(s.m.pool.approvalState, approval);
    expect((await s.svc.submit(s.req)).state).toBe("ata_submitted");
  }, 30_000);

  it("accepts a new attempt for a nullifier only after every earlier request for it ended", async () => {
    const s = await realSpend();
    s.chain.accounts.set(s.destAta, { data: new Uint8Array(165), lamports: 2_039_280n, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", executable: false });
    expect((await s.svc.submit(s.req)).state).toBe("submitted");
    const second = await s.reprove("6f1c1b7e-0000-4000-8000-000000000011", s.chain.slot + 750n);
    expect(second.publicSignals[3]).toBe(s.req.publicSignals[3]);
    await expect(s.svc.submit(second)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    // The first request's bound passes unsettled; only then may a new attempt be recorded.
    s.chain.height += 151n;
    s.chain.slot += 751n;
    await s.svc.advance(s.req.withdrawalId);
    expect(s.svc.view(s.req.withdrawalId)!.state).toBe("expired");
    const third = await s.reprove("6f1c1b7e-0000-4000-8000-000000000012", s.chain.slot + 750n);
    expect((await s.svc.submit(third)).state).toBe("ata_submitted");
    expect(s.svc.view(s.req.withdrawalId)!.state).toBe("expired");
    // The nullifier account still allows one spend: once it exists every later request is rejected.
    const nf = await spentNullifierPda(address(s.m.program.programId), address(s.m.pool.poolState), toBe32(BigInt(s.req.publicSignals[3]!)));
    s.chain.accounts.set(nf.address, { data: new Uint8Array(50), lamports: 1n, owner: s.m.program.programId, executable: false });
    s.chain.height += 151n;
    s.chain.slot += 751n;
    await s.svc.advance(third.withdrawalId);
    const fourth = await s.reprove("6f1c1b7e-0000-4000-8000-000000000013", s.chain.slot + 750n);
    await expect(s.svc.submit(fourth)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(s.chain.sent.length).toBeGreaterThan(0);
  }, 60_000);
});

describe("recovery co-signing", () => {
  async function recoveryTx(sponsor: SponsorKey, m: DeploymentManifest, opts: { closeTo?: Address; sign?: boolean } = {}) {
    const kp = await generateKeyPair();
    const fresh = await getAddressFromPublicKey(kp.publicKey);
    const mint = address(m.token.mint);
    const freshAta = (await associatedTokenAddress(fresh, mint)).address;
    const destAta = randomAddress();
    const signer = createNoopSigner(fresh);
    const ixs = [
      getTransferCheckedInstruction({ source: freshAta, mint, destination: destAta, authority: signer, amount: 100_000n, decimals: 6 }),
      getCloseAccountInstruction({ account: freshAta, destination: opts.closeTo ?? sponsor.address, owner: signer }),
    ];
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (x) => setTransactionMessageFeePayer(sponsor.address, x),
      (x) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: randomAddress() as unknown as Blockhash, lastValidBlockHeight: 10n }, x),
      (x) => appendTransactionMessageInstructions(ixs, x),
    );
    const compiled = compileTransaction(msg);
    const tx = opts.sign === false ? compiled : await partiallySignTransaction([kp], compiled);
    return { fresh, freshAta, destAta, wire: getBase64EncodedWireTransaction(tx) };
  }

  it("accepts only transfer-to-destination plus close-to-sponsor with a valid fresh-wallet signature", async () => {
    const sponsor = await testSponsor();
    const m = await testManifest(sponsor.address);
    const chain = new FakeRelayerChain();
    const db = openRelayerDb(":memory:");
    chain.db = db;
    const svc = new RecoveryService({ db, chain, sponsor, manifest: () => m, spendVk: spendVk(), sponsorCapLamports: 100_000_000n });
    const good = await recoveryTx(sponsor, m);
    chain.accounts.set(good.freshAta, { data: new Uint8Array(165), lamports: 2_039_280n, owner: "Tokenkeg", executable: false });
    const base = { lastValidBlockHeight: "10", amount: "100000" };
    const evil = await recoveryTx(sponsor, m, { closeTo: randomAddress() });
    await expect(svc.submit({ ...base, recoveryId: "6f1c1b7e-0000-4000-8000-0000000000a1", transaction: evil.wire, freshWallet: evil.fresh, destinationAta: evil.destAta })).rejects.toThrow(/rent to the sponsor/);
    const unsigned = await recoveryTx(sponsor, m, { sign: false });
    await expect(svc.submit({ ...base, recoveryId: "6f1c1b7e-0000-4000-8000-0000000000a2", transaction: unsigned.wire, freshWallet: unsigned.fresh, destinationAta: unsigned.destAta })).rejects.toThrow(/signature/);
    await expect(svc.submit({ ...base, amount: "1", recoveryId: "6f1c1b7e-0000-4000-8000-0000000000a3", transaction: good.wire, freshWallet: good.fresh, destinationAta: good.destAta })).rejects.toThrow(/transfer/);
    const ok = await svc.submit({ ...base, recoveryId: "6f1c1b7e-0000-4000-8000-0000000000a4", transaction: good.wire, freshWallet: good.fresh, destinationAta: good.destAta });
    expect(ok.state).toBe("submitted");
    expect(chain.sent.at(-1)!.persistedSignatures).toContain(ok.signature);
    chain.statuses.set(ok.signature, { confirmationStatus: "finalized", err: null });
    await svc.advance(ok.recoveryId);
    const t = sponsorTotals(db);
    expect(t.rentRecovered).toBe(2_039_280n);
    expect(t.feesSpent).toBe(0n);
  });
});

describe("HTTP boundary and deployment manifest", () => {
  const config = loadConfig({ DEVNET_RPC_URL: "https://rpc.test.invalid", EXPECTED_DEVNET_GENESIS_HASH: DEVNET_GENESIS_HASH, DEMO_TOKEN_MINT, FACILITATOR_URL: "https://facilitator.payai.network" });
  const TOKEN = `wallet-token-${"q".repeat(32)}`;

  it("SEC-02: rejects unknown (secret-bearing) fields without echoing values, and logs no bodies", async () => {
    const sponsor = await testSponsor();
    const m = await testManifest(sponsor.address);
    const chain = new FakeRelayerChain();
    const db = openRelayerDb(":memory:");
    const ctx = { db, chain, sponsor, manifest: () => m, spendVk: spendVk(), sponsorCapLamports: 1n };
    const logs: string[] = [];
    const app = createApp(createServiceHealth("relayer", config, false), {
      db,
      deployment: () => ({ state: "missing", reason: "not deployed" }),
      indexer: () => null,
      withdrawals: new WithdrawalService(ctx),
      recoveries: new RecoveryService(ctx),
      walletCredentialDigest: createHash("sha256").update(TOKEN).digest("hex"),
      log: (l) => logs.push(l),
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const secret = "31415926535897932384626433832795028841971";
      const body = { withdrawalId: "6f1c1b7e-0000-4000-8000-000000000009", nullifierSecret: secret, noteSecret: secret };
      expect((await fetch(`${base}/withdrawals`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(401);
      const res = await fetch(`${base}/withdrawals`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).not.toContain(secret);
      expect((await fetch(`${base}/deployment`)).status).toBe(503);
      expect((await fetch(`${base}/public-state`)).status).toBe(503);
      for (const l of logs) expect(l).not.toContain(secret);
      expect(logs.every((l) => /^\[relayer\] (GET|POST) \S+ \d{3}$/.test(l))).toBe(true);
    } finally {
      server.close();
    }
  });

  it("verifies the manifest against pinned circuits and the chain; any mismatch is terminal", async () => {
    dir = mkdtempSync(join(tmpdir(), "veilo-manifest-"));
    const sponsor = await testSponsor();
    const m = await testManifest(sponsor.address);
    const chain = new FakeRelayerChain();
    const path = join(dir, "devnet-manifest.json");
    const opts = { manifestPath: path, repoRoot: (await import("./fixtures")).REPO, programId: m.program.programId, poolId: m.pool.poolId, mint: DEMO_TOKEN_MINT, chain };
    expect((await verifyDeployment(opts)).state).toBe("missing");
    writeFileSync(path, JSON.stringify({ ...m, crypto: { vectorsSha256: (await import("node:crypto")).createHash("sha256").update((await import("node:fs")).readFileSync(join(opts.repoRoot, "artifacts/vectors/v1.json"))).digest("hex") } }));
    expect(await verifyDeployment(opts)).toMatchObject({ state: "mismatch", reason: expect.stringMatching(/not an executable program/) });
    chain.accounts.set(m.program.programId, { data: new Uint8Array(0), lamports: 1n, owner: "BPFLoaderUpgradeab1e11111111111111111111111", executable: true });
    publishPool(chain, m, { tree: new MerkleTree(p), roots: [new MerkleTree(p).root], approvedRoot: 0n, approvedVersion: 0n, head: 0n, tail: 0n, liability: 0n });
    expect((await verifyDeployment(opts)).state).toBe("verified");
    const tampered = JSON.parse(JSON.stringify(m)) as DeploymentManifest;
    tampered.circuits.spend.zkeySha256 = "f".repeat(64);
    writeFileSync(path, JSON.stringify(tampered));
    expect(await verifyDeployment(opts)).toMatchObject({ state: "mismatch" });
    expect(await verifyDeployment({ ...opts, programId: randomAddress() })).toMatchObject({ state: "mismatch" });
  });
});

void RelayerError;

describe("approved-root operator rule", () => {
  it("approves only inserted deposits of configured test participants, keeping prior order", async () => {
    const { applyApprovalRule } = await import("../src/cli/approve-root");
    const { PoolReplay } = await import("@veilo/privacy-sdk");
    const pool = randomAddress();
    const r = new PoolReplay(p, pool);
    const alice = randomAddress();
    const mallory = randomAddress();
    r.apply({ name: "PoolInitialized", pool, poolId: new Uint8Array(32), mint: randomAddress(), tokenProgram: randomAddress(), vault: randomAddress(), genesisHash: new Uint8Array(32), emptyRoot: new MerkleTree(p).root, configAuthority: randomAddress(), approvalAuthority: randomAddress(), protocolVersion: 1 });
    let liability = 0n;
    const dep = (seq: bigint, who: Address, label: bigint) => {
      liability += 100_000n;
      r.apply({ name: "DepositQueued", pool, queueSeq: seq, amount: 100_000n, refundAuthority: who, salt: new Uint8Array(32), label, precommitment: 7n, commitment: p.h3(100_000n, label, 7n), liability });
    };
    dep(0n, alice, 11n);
    dep(1n, mallory, 22n);
    dep(2n, alice, 33n);
    r.apply({ name: "LeafInserted", pool, queueSeq: 0n, kind: "deposit", leafIndex: 0n, commitment: p.h3(100_000n, 11n, 7n), newRoot: (() => { const t = new MerkleTree(p); t.append(p.h3(100_000n, 11n, 7n)); return t.root; })() });
    expect(applyApprovalRule(r, new Set([alice]), [])).toEqual([11n]);
    expect(applyApprovalRule(r, new Set([alice]), [99n])).toEqual([99n, 11n]);
    expect(applyApprovalRule(r, new Set([mallory]), [])).toEqual([]);
  });
});
