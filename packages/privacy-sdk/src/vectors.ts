import { address, getAddressDecoder, type Address } from "@solana/kit";
import { bytesToHex, FIELD_MODULUS, hexToBytes, toBe32, U64_MAX, u64Be } from "./field";
import { intentContext, IntentError, validateIntent, type IntentContextFields, type WithdrawalIntent } from "./intent";
import { deriveFieldSecret, deriveOneTimeSeed, deriveSalt, hkdfOutput } from "./keys";
import { addressBytes, deriveLabel, type LabelInputs } from "./label";
import { changeNote, commitment, nullifierHash, precommitment, type Note, type NoteSecrets } from "./note";
import {
  approvalStatePda,
  associatedTokenAddress,
  pendingChangePda,
  pendingDepositPda,
  poolStatePda,
  seenPrecommitmentPda,
  spentNullifierPda,
  vaultAuthorityPda,
  type Pda,
} from "./pda";
import { getPoseidon, type Poseidon } from "./poseidon";
import { MerkleTree, zeroValues, TREE_DEPTH, type MerklePath } from "./tree";
import { insertWitness } from "./witness";

// Reference inputs shared by the vector sections.
export const DEVNET_GENESIS_HEX = "ce59db5080fc2c6d3bcf7ca90712d3c2e5e6c28f27f0dfbb9953bdb0894c03ab";
export const DEVNET_USDC_MINT = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
export const SETUP_WALLET = address("3FCio7smQJX7fm5x4Rz2UPPesfHA46FkexC3S3SqkMFd");

const fill = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);
const seq32 = (): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => i);
const dec = (x: bigint): string => x.toString(10);
const hex = bytesToHex;

export function secretsAt(seed: Uint8Array, index: number): NoteSecrets {
  const nullifierSecret = deriveFieldSecret(seed, "nullifier", index);
  const noteSecret = deriveFieldSecret(seed, "secret", index);
  if (nullifierSecret === null || noteSecret === null) throw new Error(`zero secret at index ${index}`);
  return { nullifierSecret, noteSecret };
}

function fieldSection() {
  const canonical = [0n, 1n, 1_000_000n, U64_MAX, FIELD_MODULUS - 1n].map((v) => ({ value: dec(v), be32: hex(toBe32(v)) }));
  const u64 = [0n, 1n, 1_000_000n, 400_000_750n, U64_MAX].map((v) => ({
    value: dec(v),
    be8: hex(u64Be(v)),
    le8: hex(new Uint8Array(new BigUint64Array([v]).buffer)),
    be32: hex(toBe32(v)),
  }));
  const rHex = FIELD_MODULUS.toString(16).padStart(64, "0");
  const nonCanonical = [
    { hex: rHex, reason: "equals r" },
    { hex: (FIELD_MODULUS + 1n).toString(16).padStart(64, "0"), reason: "r + 1" },
    { hex: "ff".repeat(32), reason: "2^256 - 1" },
    { hex: "01".repeat(31), reason: "31 bytes" },
    { hex: "00" + "01".repeat(32), reason: "33 bytes" },
  ];
  return { r: dec(FIELD_MODULUS), rBe32: rHex, canonical, u64, nonCanonical };
}

function poseidonSection(p: Poseidon) {
  const rm1 = FIELD_MODULUS - 1n;
  const cases: [string, bigint[]][] = [
    ["H2", [1n, 2n]],
    ["H2", [0n, 0n]],
    ["H3", [1n, 2n, 3n]],
    ["H3", [0n, 0n, 0n]],
    ["H2", [rm1, rm1]],
    ["H3", [rm1, rm1, rm1]],
  ];
  return cases.map(([fn, inputs]) => ({
    fn,
    inputs: inputs.map(dec),
    output: dec(fn === "H2" ? p.h2(inputs[0]!, inputs[1]!) : p.h3(inputs[0]!, inputs[1]!, inputs[2]!)),
  }));
}

export function labelCases(): (LabelInputs & { name: string })[] {
  const seed = seq32();
  return [
    { name: "draft-11-22-33-44", pool: fill(0x11), mint: fill(0x22), refundAuthority: fill(0x33), salt: fill(0x44) },
    {
      name: "devnet-usdc-setup-wallet",
      pool: fill(0x11),
      mint: addressBytes(DEVNET_USDC_MINT),
      refundAuthority: addressBytes(SETUP_WALLET),
      salt: deriveSalt(seed, 0),
    },
    {
      name: "devnet-usdc-other-signer",
      pool: fill(0x11),
      mint: addressBytes(DEVNET_USDC_MINT),
      refundAuthority: fill(0x99),
      salt: deriveSalt(seed, 0),
    },
  ];
}

function labelSection() {
  return labelCases().map((c) => {
    const d = deriveLabel(c);
    return {
      name: c.name,
      pool: hex(c.pool),
      mint: hex(c.mint),
      refundAuthority: hex(c.refundAuthority),
      salt: hex(c.salt),
      preimage: hex(d.preimage),
      sha256: hex(d.sha256),
      label: dec(d.label),
      labelBe32: hex(toBe32(d.label)),
    };
  });
}

export const DRAFT_CTX: IntentContextFields = {
  programId: fill(0xaa),
  pool: fill(0x11),
  genesisHash: hexToBytes(DEVNET_GENESIS_HEX),
  mint: addressBytes(DEVNET_USDC_MINT),
};

export function draftIntent(overrides: Partial<WithdrawalIntent>): WithdrawalIntent {
  return {
    destinationTokenAccount: fill(0x55),
    destinationOwner: fill(0x66),
    payoutAmount: 1_000_000n,
    relayerFee: 0n,
    relayer: null,
    relayerFeeTokenAccount: null,
    validUntilSlot: 400_000_750n,
    ...overrides,
  };
}

function intentJson(ctx: IntentContextFields, i: WithdrawalIntent) {
  return {
    programId: hex(ctx.programId),
    pool: hex(ctx.pool),
    genesisHash: hex(ctx.genesisHash),
    mint: hex(ctx.mint),
    destinationTokenAccount: hex(i.destinationTokenAccount),
    destinationOwner: hex(i.destinationOwner),
    payoutAmount: dec(i.payoutAmount),
    relayerFee: dec(i.relayerFee),
    relayer: i.relayer === null ? null : hex(i.relayer),
    relayerFeeTokenAccount: i.relayerFeeTokenAccount === null ? null : hex(i.relayerFeeTokenAccount),
    validUntilSlot: dec(i.validUntilSlot),
  };
}

function intentSection() {
  const valid: [string, WithdrawalIntent][] = [
    ["draft-no-relayer", draftIntent({})],
    [
      "draft-relayer-fee",
      draftIntent({ payoutAmount: 990_000n, relayerFee: 10_000n, relayer: fill(0x77), relayerFeeTokenAccount: fill(0x88) }),
    ],
    ["relayer-zero-fee", draftIntent({ relayer: fill(0x77) })],
    [
      "max-u64",
      draftIntent({
        payoutAmount: U64_MAX - 1n,
        relayerFee: 1n,
        relayer: fill(0x77),
        relayerFeeTokenAccount: fill(0x88),
        validUntilSlot: U64_MAX,
      }),
    ],
  ];
  const validJson = valid.map(([name, i]) => {
    const d = intentContext(DRAFT_CTX, i);
    return {
      name,
      ...intentJson(DRAFT_CTX, i),
      intentBytes: hex(d.bytes),
      sha256: hex(d.sha256),
      context: dec(d.context),
      contextBe32: hex(toBe32(d.context)),
      withdrawnValue: dec(d.withdrawnValue),
    };
  });

  const slot = 400_000_000n;
  const invalid: [string, WithdrawalIntent, bigint, bigint][] = [
    ["payout-zero", draftIntent({ payoutAmount: 0n }), 0n, slot],
    ["amount-overflow", draftIntent({ payoutAmount: U64_MAX, relayerFee: 1n, relayer: fill(0x77), relayerFeeTokenAccount: fill(0x88) }), 100n, slot],
    ["fee-without-relayer", draftIntent({ relayerFee: 1n }), 100n, slot],
    ["fee-account-without-relayer", draftIntent({ relayerFeeTokenAccount: fill(0x88) }), 100n, slot],
    ["fee-without-fee-account", draftIntent({ relayerFee: 1n, relayer: fill(0x77) }), 100n, slot],
    ["fee-account-with-zero-fee", draftIntent({ relayer: fill(0x77), relayerFeeTokenAccount: fill(0x88) }), 100n, slot],
    ["fee-above-pool-max", draftIntent({ relayerFee: 1n, relayer: fill(0x77), relayerFeeTokenAccount: fill(0x88) }), 0n, slot],
    ["expired", draftIntent({}), 0n, 400_000_751n],
    ["too-far-in-future", draftIntent({}), 0n, 399_999_999n],
  ];
  const invalidJson = invalid.map(([name, i, maxRelayerFee, currentSlot]) => {
    let error = "none";
    try {
      validateIntent(i, maxRelayerFee, currentSlot);
    } catch (e) {
      if (!(e instanceof IntentError)) throw e;
      error = e.code;
    }
    if (error === "none") throw new Error(`invalid intent vector ${name} validated`);
    return { name, ...intentJson(DRAFT_CTX, i), maxRelayerFee: dec(maxRelayerFee), currentSlot: dec(currentSlot), error };
  });
  // Boundary: exactly MAX_INTENT_SLOTS ahead and exactly at the bound are accepted.
  for (const s of [slot, 400_000_750n]) validateIntent(draftIntent({}), 0n, s);
  return {
    boundary: { validUntilSlot: "400000750", acceptedCurrentSlots: ["400000000", "400000750"] },
    valid: validJson,
    invalid: invalidJson,
  };
}

interface NoteCase {
  name: string;
  note: Note;
  changes: { withdrawn: bigint; fresh: NoteSecrets }[];
}

function noteCases(): NoteCase[] {
  const seed = seq32();
  const label = deriveLabel(labelCases()[1]!).label;
  return [
    {
      name: "deposit-1000000",
      note: { value: 1_000_000n, label, ...secretsAt(seed, 0) },
      changes: [
        { withdrawn: 400_000n, fresh: secretsAt(seed, 1) },
        { withdrawn: 1_000_000n, fresh: secretsAt(seed, 2) },
      ],
    },
    {
      name: "max-value",
      note: { value: U64_MAX, label, ...secretsAt(seed, 3) },
      changes: [{ withdrawn: 1n, fresh: secretsAt(seed, 4) }],
    },
  ];
}

function noteJson(p: Poseidon, n: Note) {
  return {
    value: dec(n.value),
    label: dec(n.label),
    nullifierSecret: dec(n.nullifierSecret),
    noteSecret: dec(n.noteSecret),
    precommitment: dec(precommitment(p, n)),
    commitment: dec(commitment(p, n)),
    nullifierHash: dec(nullifierHash(p, n)),
  };
}

function noteSection(p: Poseidon) {
  return noteCases().map((c) => ({
    name: c.name,
    ...noteJson(p, c.note),
    changes: c.changes.map(({ withdrawn, fresh }) => ({
      withdrawn: dec(withdrawn),
      ...noteJson(p, changeNote(c.note, withdrawn, fresh)),
    })),
  }));
}

function pathJson(path: MerklePath) {
  return {
    index: path.index,
    leaf: dec(path.leaf),
    siblings: path.siblings.map(dec),
    pathBits: path.pathBits,
    root: dec(path.root),
  };
}

/** State tree: six appended commitments; approved tree: three labels. */
export function sampleTrees(p: Poseidon): { state: MerkleTree; approved: MerkleTree } {
  const notes = noteCases();
  const state = new MerkleTree(p, TREE_DEPTH);
  const leaves = [
    commitment(p, notes[0]!.note),
    commitment(p, notes[1]!.note),
    ...[1n, 2n, 3n].map((v) => p.h2(v, v)),
    commitment(p, changeNote(notes[0]!.note, 400_000n, notes[0]!.changes[0]!.fresh)),
  ];
  leaves.forEach((l) => state.append(l));
  const approved = new MerkleTree(p, TREE_DEPTH);
  const labels = labelCases().map((c) => deriveLabel(c).label);
  [labels[0]!, labels[1]!, labels[2]!].forEach((l) => approved.append(l));
  return { state, approved };
}

function merkleSection(p: Poseidon) {
  const { state, approved } = sampleTrees(p);
  return {
    depth: TREE_DEPTH,
    state: {
      leaves: Array.from({ length: state.size }, (_, i) => dec(state.leaf(i))),
      root: dec(state.root),
      paths: [0, 1, 5].map((i) => pathJson(state.path(i))),
    },
    approved: {
      leaves: Array.from({ length: approved.size }, (_, i) => dec(approved.leaf(i))),
      root: dec(approved.root),
      paths: [1].map((i) => pathJson(approved.path(i))),
    },
  };
}

export interface InsertStepVector {
  queueSeq: number;
  kind: string;
  skipped: boolean;
  root?: string;
  nextLeafIndex?: number;
  oldRoot?: string;
  newRoot?: string;
  leafIndex?: number;
  leaf?: string;
  siblings?: string[];
}

function insertSection(p: Poseidon): InsertStepVector[] {
  const notes = noteCases();
  const n0 = notes[0]!;
  // Queue: deposit (seq 0), refunded+skipped deposit (seq 1, no leaf), deposit (seq 2), change (seq 3).
  const queue: { queueSeq: number; kind: string; leaf: bigint | null }[] = [
    { queueSeq: 0, kind: "deposit", leaf: commitment(p, n0.note) },
    { queueSeq: 1, kind: "refunded-skipped", leaf: null },
    { queueSeq: 2, kind: "deposit", leaf: commitment(p, notes[1]!.note) },
    { queueSeq: 3, kind: "change", leaf: commitment(p, changeNote(n0.note, 400_000n, n0.changes[0]!.fresh)) },
  ];
  const tree = new MerkleTree(p, TREE_DEPTH);
  const steps: InsertStepVector[] = [];
  for (const item of queue) {
    if (item.leaf === null) {
      steps.push({ queueSeq: item.queueSeq, kind: item.kind, skipped: true, root: dec(tree.root), nextLeafIndex: tree.size });
      continue;
    }
    const w = insertWitness(p, { path: tree.path(tree.size), leaf: item.leaf });
    const leafIndex = tree.append(item.leaf);
    if (w.publicSignals[1] !== tree.root) throw new Error("insert witness root mismatch");
    steps.push({
      queueSeq: item.queueSeq,
      kind: item.kind,
      skipped: false,
      oldRoot: dec(w.publicSignals[0]!),
      newRoot: dec(w.publicSignals[1]!),
      leafIndex,
      leaf: dec(item.leaf),
      siblings: (w.inputs.siblings as string[]).slice(),
    });
  }
  return steps;
}

function keysSection() {
  const seeds = [seq32(), fill(0xff)];
  const out = [];
  for (const seed of seeds) {
    for (const index of [0, 1, 7, 1_000_000]) {
      out.push({
        seed: hex(seed),
        index,
        nullifierOkm: hex(hkdfOutput(seed, "nullifier", index)),
        nullifierSecret: dec(deriveFieldSecret(seed, "nullifier", index) ?? 0n),
        secretOkm: hex(hkdfOutput(seed, "secret", index)),
        noteSecret: dec(deriveFieldSecret(seed, "secret", index) ?? 0n),
        salt: hex(deriveSalt(seed, index)),
        onetimeSeed: hex(deriveOneTimeSeed(seed, index)),
      });
    }
  }
  return out;
}

async function pdaSection(p: Poseidon) {
  const programId = getAddressDecoder().decode(fill(0xaa)) as Address;
  const poolId = fill(0x01);
  const pool = await poolStatePda(programId, poolId);
  const note = noteCases()[0]!.note;
  const pre = toBe32(precommitment(p, note));
  const nf = toBe32(nullifierHash(p, note));
  const vaultAuthority = await vaultAuthorityPda(programId, pool.address);
  const j = (x: Pda) => ({ address: x.address, bump: x.bump });
  return {
    programId,
    programIdHex: hex(fill(0xaa)),
    poolId: hex(poolId),
    mint: DEVNET_USDC_MINT,
    poolState: j(pool),
    vaultAuthority: j(vaultAuthority),
    vault: j(await associatedTokenAddress(vaultAuthority.address, DEVNET_USDC_MINT)),
    approvalState: j(await approvalStatePda(programId, pool.address)),
    pendingDeposit: await Promise.all(
      [0n, 1n, U64_MAX].map(async (s) => ({ queueSeq: dec(s), ...j(await pendingDepositPda(programId, pool.address, s)) })),
    ),
    seenPrecommitment: { precommitment: hex(pre), ...j(await seenPrecommitmentPda(programId, pool.address, pre)) },
    pendingChange: { nullifierHash: hex(nf), ...j(await pendingChangePda(programId, pool.address, nf)) },
    spentNullifier: { nullifierHash: hex(nf), ...j(await spentNullifierPda(programId, pool.address, nf)) },
  };
}

export async function buildVectors() {
  const p = await getPoseidon();
  const zeros = zeroValues(p, TREE_DEPTH);
  return {
    version: "v1",
    protocolVersion: 1,
    generatedBy: "packages/privacy-sdk (pnpm vectors:generate); never edit by hand",
    field: fieldSection(),
    poseidon: poseidonSection(p),
    label: labelSection(),
    intent: intentSection(),
    note: noteSection(p),
    zeros: zeros.map(dec),
    emptyRoot: dec(zeros[TREE_DEPTH]!),
    emptyRootBe32: hex(toBe32(zeros[TREE_DEPTH]!)),
    merkle: merkleSection(p),
    insert: insertSection(p),
    keys: keysSection(),
    pda: await pdaSection(p),
  };
}

export type VectorsV1 = Awaited<ReturnType<typeof buildVectors>>;
