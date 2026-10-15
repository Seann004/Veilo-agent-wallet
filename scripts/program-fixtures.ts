// Generates real Groth16 proofs for the privacy-pool LiteSVM tests (programs/privacy-pool/litesvm).
// Every key, salt and note secret is a fixed test value, so the Rust tests can replay the exact
// scenario and reach the same pool addresses, labels, roots and intent contexts.
//   pnpm tsx scripts/program-fixtures.ts [outFile]
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddressDecoder, type Address } from "@solana/kit";
import {
  addressBytes,
  associatedTokenAddress,
  bytesToHex,
  commitment,
  deriveFieldSecret,
  deriveLabel,
  deriveSalt,
  exitWitness,
  getPoseidon,
  insertWitness,
  intentContext,
  MerkleTree,
  nullifierHash,
  poolStatePda,
  precommitment,
  prove,
  spendWitness,
  toBe32,
  toSolanaProof,
  type CircuitWitness,
  type Note,
  type NoteSecrets,
  type ProvingArtifacts,
  type WithdrawalIntent,
} from "../packages/privacy-sdk/src/index";
import { artifactPaths, MANIFEST_PATH, readJson, type MainCircuit } from "../circuits/scripts/lib";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(REPO, process.argv[2] ?? "target/program-fixtures/fixtures.json");

const DEVNET_GENESIS = "ce59db5080fc2c6d3bcf7ca90712d3c2e5e6c28f27f0dfbb9953bdb0894c03ab";
const DECIMALS = 6;
/** Slot the tests warp to before any spend; intents expire at SPEND_VALID_UNTIL. */
const SPEND_SLOT = 1000n;
const SPEND_VALID_UNTIL = 1500n;

const hex = (b: Uint8Array): string => bytesToHex(b);
const sha = (s: string): Uint8Array => new Uint8Array(createHash("sha256").update(s).digest());
const decoder = getAddressDecoder();
const addr = (b: Uint8Array): Address => decoder.decode(b);

function programId(): Uint8Array {
  const src = readFileSync(resolve(REPO, "programs/privacy-pool/src/lib.rs"), "utf8");
  const m = /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/.exec(src);
  if (!m?.[1]) throw new Error("declare_id! not found");
  return addressBytes(m[1]);
}

/** Ed25519 public key for a 32-byte seed (the same derivation as solana-keypair `new_from_array`). */
function ed25519Public(seed: Uint8Array): Uint8Array {
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed)]);
  const jwk = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({ format: "jwk" });
  return new Uint8Array(Buffer.from(jwk.x ?? "", "base64url"));
}

interface Key {
  seed: string;
  address: string;
  bytes: Uint8Array;
}

function key(name: string): Key {
  const seed = sha(`veilo-test/keypair/${name}`);
  const bytes = ed25519Public(seed);
  return { seed: hex(seed), address: hex(bytes), bytes };
}

function artifacts(name: MainCircuit): ProvingArtifacts {
  const m = readJson<{ circuits: Record<string, { wasmSha256: string; zkeySha256: string }> }>(MANIFEST_PATH).circuits[name]!;
  const p = artifactPaths(name);
  return { wasmPath: p.wasm, wasmSha256: m.wasmSha256, zkeyPath: p.zkey, zkeySha256: m.zkeySha256 };
}

async function proofHex(name: MainCircuit, w: CircuitWitness) {
  const { proof } = await prove(w, artifacts(name));
  const s = toSolanaProof(proof);
  return { a: hex(s.a), b: hex(s.b), c: hex(s.c) };
}

const f32 = (x: bigint): string => hex(toBe32(x));

async function main(): Promise<void> {
  const p = await getPoseidon();
  const program = programId();
  const mintKey = key("mint");
  const mint = mintKey.bytes;
  const names = ["deployer", "approver", "config", "payer", "relayer", "alice", "bob", "carol", "dave", "mallory", "w1", "w2", "w3"] as const;
  const keys = Object.fromEntries(names.map((n) => [n, key(n)])) as Record<(typeof names)[number], Key>;

  const poolIdA = sha("veilo-test/pool/A");
  const poolIdB = sha("veilo-test/pool/B");
  const poolA = (await poolStatePda(addr(program), poolIdA)).address;
  const poolB = (await poolStatePda(addr(program), poolIdB)).address;
  const poolABytes = addressBytes(poolA);
  const ata = async (owner: Uint8Array) => addressBytes((await associatedTokenAddress(addr(owner), addr(mint))).address);

  // Deterministic per-owner note seeds stand in for the wallet service's note seed.
  const noteSeed = (who: string) => sha(`veilo-test/note-seed/${who}`);
  const secrets = (who: string, i: number): NoteSecrets => {
    const s = noteSeed(who);
    const n = deriveFieldSecret(s, "nullifier", i);
    const t = deriveFieldSecret(s, "secret", i);
    if (n === null || t === null) throw new Error("zero secret");
    return { nullifierSecret: n, noteSecret: t };
  };

  type Dep = { name: string; owner: keyof typeof keys; amount: bigint; seq: number };
  const plan: Dep[] = [
    { name: "alice", owner: "alice", amount: 5_000_000n, seq: 0 },
    { name: "bob", owner: "bob", amount: 1_000_000n, seq: 1 },
    { name: "carol", owner: "carol", amount: 2_000_000n, seq: 2 },
    { name: "dave", owner: "dave", amount: 300_000n, seq: 3 },
  ];
  const notes: Record<string, Note> = {};
  const deposits = plan.map((d) => {
    const s = secrets(d.owner, 0);
    const salt = deriveSalt(noteSeed(d.owner), 0);
    const label = deriveLabel({ pool: poolABytes, mint, refundAuthority: keys[d.owner].bytes, salt }).label;
    const pre = precommitment(p, s);
    const note: Note = { value: d.amount, label, ...s };
    notes[d.name] = note;
    return {
      name: d.name,
      owner: d.owner,
      amount: d.amount.toString(),
      seq: d.seq,
      precommitment: f32(pre),
      salt: hex(salt),
      label: f32(label),
      commitment: f32(commitment(p, note)),
    };
  });
  const commit = (n: string) => commitment(p, notes[n]!);

  const tree = new MerkleTree(p);
  const roots: Record<string, string> = { R0: f32(tree.root) };
  const inserts: Record<string, unknown> = {};
  const insertAt = async (name: string, leaf: bigint, append: boolean) => {
    const path = tree.path(tree.size);
    const w = insertWitness(p, { path, leaf });
    const [oldRoot, newRoot, leafIndex] = w.publicSignals as [bigint, bigint, bigint, bigint];
    inserts[name] = { proof: await proofHex("insert", w), oldRoot: f32(oldRoot), newRoot: f32(newRoot), leafIndex: Number(leafIndex), leaf: f32(leaf) };
    if (append) tree.append(leaf);
  };

  // Valid proof that inserts bob's leaf at index 0 while alice's deposit is the queue head.
  await insertAt("forged_bob_at_0", commit("bob"), false);
  await insertAt("alice", commit("alice"), true);
  roots.R1 = f32(tree.root);
  await insertAt("bob", commit("bob"), true);
  roots.R2 = f32(tree.root);
  // Built for carol's record before her refund; the refund must make it unusable.
  await insertAt("carol_refunded", commit("carol"), false);
  await insertAt("dave", commit("dave"), true);
  roots.R3 = f32(tree.root);

  const exits: Record<string, unknown> = {};
  const exit = async (name: string, note: Note, leafIndex: number, owner: string, salt: Uint8Array) => {
    const w = exitWitness(p, { note, statePath: tree.path(leafIndex) });
    exits[name] = {
      proof: await proofHex("exit", w),
      stateRoot: f32(tree.root),
      nullifierHash: f32(nullifierHash(p, note)),
      value: note.value.toString(),
      label: f32(note.label),
      owner,
      salt: hex(salt),
    };
  };
  // Original notes exit against R3; the change note against R5.
  await exit("alice_0", notes.alice!, 0, "alice", deriveSalt(noteSeed("alice"), 0));
  await exit("bob", notes.bob!, 1, "bob", deriveSalt(noteSeed("bob"), 0));

  const approvedTree = (labels: bigint[]) => {
    const t = new MerkleTree(p);
    labels.forEach((l) => t.append(l));
    return t;
  };
  const approvedA = approvedTree([notes.alice!.label, notes.dave!.label]);
  const approvedB = approvedTree([notes.dave!.label]);
  const approvedX = approvedTree([notes.bob!.label]);
  const approvedRoots = { RA: f32(approvedA.root), RB: f32(approvedB.root), RX: f32(approvedX.root) };

  const ctx = { programId: program, pool: poolABytes, genesisHash: Buffer.from(DEVNET_GENESIS, "hex"), mint };
  const spends: Record<string, unknown> = {};
  const spend = async (
    name: string,
    note: Note,
    leafIndex: number,
    approved: MerkleTree,
    approvedIndex: number,
    intent: WithdrawalIntent,
    change: NoteSecrets,
  ) => {
    const { context, withdrawnValue } = intentContext(ctx, intent);
    const w = spendWitness(p, {
      note,
      statePath: tree.path(leafIndex),
      approvedPath: approved.path(approvedIndex),
      context,
      withdrawnValue,
      change,
    });
    spends[name] = {
      proof: await proofHex("spend", w),
      stateRoot: f32(tree.root),
      approvedRoot: f32(approved.root),
      nullifierHash: f32(w.nullifierHash),
      newCommitment: f32(w.newCommitment),
      withdrawn: withdrawnValue.toString(),
      changeValue: w.changeNote.value.toString(),
      intent: {
        destinationTokenAccount: hex(intent.destinationTokenAccount),
        destinationOwner: hex(intent.destinationOwner),
        payoutAmount: intent.payoutAmount.toString(),
        relayerFee: intent.relayerFee.toString(),
        relayer: intent.relayer === null ? null : hex(intent.relayer),
        relayerFeeTokenAccount: intent.relayerFeeTokenAccount === null ? null : hex(intent.relayerFeeTokenAccount),
        validUntilSlot: intent.validUntilSlot.toString(),
      },
    };
    return w.changeNote;
  };
  const intentTo = async (owner: Uint8Array, payout: bigint): Promise<WithdrawalIntent> => ({
    destinationTokenAccount: await ata(owner),
    destinationOwner: owner,
    payoutAmount: payout,
    relayerFee: 0n,
    relayer: null,
    relayerFeeTokenAccount: null,
    validUntilSlot: SPEND_VALID_UNTIL,
  });

  // Bob's label is not in the published approved root; this proof uses a root that only bob approves.
  await spend("bob_unapproved", notes.bob!, 1, approvedX, 0, await intentTo(keys.w1.bytes, 500_000n), secrets("bob", 1));

  const c0 = await spend("alice_0", notes.alice!, 0, approvedA, 0, await intentTo(keys.w1.bytes, 1_200_000n), secrets("alice", 1));
  await insertAt("change_0", commitment(p, c0), true);
  roots.R4 = f32(tree.root);
  const relayerIntent: WithdrawalIntent = {
    ...(await intentTo(keys.w2.bytes, 790_000n)),
    relayerFee: 10_000n,
    relayer: keys.relayer.bytes,
    relayerFeeTokenAccount: await ata(keys.relayer.bytes),
  };
  const c1 = await spend("change_0", c0, 3, approvedA, 0, relayerIntent, secrets("alice", 2));
  await insertAt("change_1", commitment(p, c1), true);
  roots.R5 = f32(tree.root);
  await exit("change_1", c1, 4, "alice", deriveSalt(noteSeed("alice"), 0));
  await spend("change_1_full", c1, 4, approvedA, 0, await intentTo(keys.w3.bytes, c1.value), secrets("alice", 3));

  const out = {
    note: "Test fixtures only. All keys and note secrets are derived from public strings.",
    programId: hex(program),
    genesis: DEVNET_GENESIS,
    decimals: DECIMALS,
    spendSlot: SPEND_SLOT.toString(),
    mint: { seed: mintKey.seed, address: mintKey.address },
    keys: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, { seed: v.seed, address: v.address }])),
    pools: { A: { poolId: hex(poolIdA), pool: hex(poolABytes) }, B: { poolId: hex(poolIdB), pool: hex(addressBytes(poolB)) } },
    deposits,
    roots,
    approvedRoots,
    inserts,
    spends,
    exits,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote ${OUT}: ${Object.keys(inserts).length} insert, ${Object.keys(spends).length} spend, ${Object.keys(exits).length} exit proofs`);
}

// snarkjs keeps worker threads alive after proving, so exit explicitly.
main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
