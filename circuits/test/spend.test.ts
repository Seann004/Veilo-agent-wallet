import { beforeAll, describe, expect, it } from "vitest";
import {
  commitment,
  FIELD_MODULUS,
  MerkleTree,
  nullifierHash,
  precommitment,
  secretsAt,
  spendWitness,
  TREE_DEPTH,
  verifyProof,
  type GeneratedProof,
  type Note,
  type SpendParams,
  type SpendWitness,
} from "@veilo/privacy-sdk";
import { resolve } from "node:path";
import { CIRCUITS_DIR } from "../scripts/lib";
import { expectConstraintFailure, getFixture, proveCircuit, rawVerify, SEED, verificationKey, withInputs, type Fixture } from "./helpers";

const MERKLE = resolve(CIRCUITS_DIR, "src/lib/merkle.circom");

let f: Fixture;
let base: SpendParams;
let valid: SpendWitness;
let proof: GeneratedProof;

beforeAll(async () => {
  f = await getFixture();
  base = {
    note: f.noteA,
    statePath: f.state.path(0),
    approvedPath: f.approved.path(f.approvedIndexA),
    context: f.context(400_000n),
    withdrawnValue: 400_000n,
    change: secretsAt(SEED, 1),
  };
  valid = spendWitness(f.p, base);
  proof = await proveCircuit("spend", valid);
});

describe("spend: valid proofs (PRIV-01)", () => {
  it("accepts a real proof for an original deposit note", async () => {
    expect(proof.publicSignals).toEqual(valid.publicSignals.map(String));
    expect(await verifyProof(verificationKey("spend"), proof.publicSignals, proof.proof)).toBe(true);
  });

  it("accepts a real proof spending the inserted change note, down to a zero remainder", async () => {
    const tree = new MerkleTree(f.p, TREE_DEPTH);
    for (let i = 0; i < f.state.size; i++) tree.append(f.state.leaf(i));
    const changeIndex = tree.append(valid.newCommitment);
    const change: Note = valid.changeNote;
    expect(change.label).toBe(f.noteA.label);
    expect(change.value).toBe(600_000n);
    const w = spendWitness(f.p, {
      note: change,
      statePath: tree.path(changeIndex),
      approvedPath: f.approved.path(f.approvedIndexA),
      context: f.context(600_000n),
      withdrawnValue: 600_000n,
      change: secretsAt(SEED, 2),
    });
    expect(w.changeNote.value).toBe(0n);
    const p = await proveCircuit("spend", w);
    expect(await verifyProof(verificationKey("spend"), p.publicSignals, p.proof)).toBe(true);
    // Both spends of the same label have distinct nullifiers.
    expect(w.nullifierHash).not.toBe(valid.nullifierHash);
  });
});

describe("spend: proof-level rejections (PRIV-02)", () => {
  it("rejects every single public input changed by +1", async () => {
    for (let i = 0; i < proof.publicSignals.length; i++) {
      const signals = [...proof.publicSignals];
      signals[i] = ((BigInt(signals[i]!) + 1n) % FIELD_MODULUS).toString();
      expect(await verifyProof(verificationKey("spend"), signals, proof.proof)).toBe(false);
    }
  });

  it("rejects a proof bound to a different intent context (EXP-01 circuit side)", async () => {
    const signals = [...proof.publicSignals];
    signals[0] = f.context(400_000n, 1n).toString();
    expect(signals[0]).not.toBe(proof.publicSignals[0]);
    expect(await verifyProof(verificationKey("spend"), signals, proof.proof)).toBe(false);
  });

  it("rejects swapped and duplicated public inputs", async () => {
    const s = proof.publicSignals;
    const swapped = [s[0]!, s[2]!, s[1]!, s[3]!, s[4]!, s[5]!];
    const dupNullifier = [s[0]!, s[1]!, s[2]!, s[5]!, s[4]!, s[5]!];
    const dupRoot = [s[0]!, s[1]!, s[1]!, s[3]!, s[4]!, s[5]!];
    for (const signals of [swapped, dupNullifier, dupRoot]) {
      expect(await verifyProof(verificationKey("spend"), signals, proof.proof)).toBe(false);
    }
  });

  it("rejects the x + r alias of the nullifier hash", async () => {
    const signals = [...proof.publicSignals];
    signals[3] = (BigInt(signals[3]!) + FIELD_MODULUS).toString();
    expect(await rawVerify("spend", signals, proof.proof)).toBe(false);
    expect(await verifyProof(verificationKey("spend"), signals, proof.proof)).toBe(false);
  });

  it("rejects a proof checked against the wrong circuit's key", async () => {
    expect(await verifyProof(verificationKey("exit"), proof.publicSignals.slice(0, 4), proof.proof)).toBe(false);
  });
});

describe("spend: constraint failures", () => {
  it("wrong state root (PRIV-04)", async () => {
    await expectConstraintFailure("spend", withInputs(valid, { stateRoot: f.state.zeros[TREE_DEPTH]!.toString() }), {
      template: "Spend",
      statement: "stateMerkle.root === stateRoot;",
    });
  });

  it("withdrawn > value: the remainder wraps to p - 1 and fails its 64-bit range check (PRIV-04)", async () => {
    const w = spendWitness(f.p, { ...base, withdrawnValue: 400_000n });
    await expectConstraintFailure("spend", withInputs(w, { withdrawnValue: (f.noteA.value + 1n).toString() }), { template: "Num2Bits", caller: { template: "Spend", statement: "remainderBits.in <== remainder;" } });
  });

  it("withdrawn = p - 1 (a negative withdrawal) fails the 64-bit range check", async () => {
    await expectConstraintFailure("spend", withInputs(valid, { withdrawnValue: (FIELD_MODULUS - 1n).toString() }), { template: "Num2Bits", caller: { template: "Spend", statement: "withdrawnBits.in <== withdrawnValue;" } });
  });

  it("withdrawn = 2^64 + w fails the 64-bit range check", async () => {
    await expectConstraintFailure("spend", withInputs(valid, { withdrawnValue: ((1n << 64n) + 400_000n).toString() }), { template: "Num2Bits", caller: { template: "Spend", statement: "withdrawnBits.in <== withdrawnValue;" } });
  });

  it("a committed note value of 2^64 fails the 64-bit range check", async () => {
    const big: Note = { ...f.noteA, value: 1n << 64n, ...secretsAt(SEED, 20) };
    const tree = new MerkleTree(f.p, TREE_DEPTH);
    // The SDK refuses to build this leaf; an attacker would hash it directly.
    const idx = tree.append(f.p.h3(big.value, big.label, precommitment(f.p, big)));
    const inputs = withInputs(valid, {
      value: big.value.toString(),
      nullifierSecret: big.nullifierSecret.toString(),
      noteSecret: big.noteSecret.toString(),
      stateRoot: tree.root.toString(),
      stateIndex: String(idx),
      stateSiblings: tree.path(idx).siblings.map(String),
      nullifierHash: nullifierHash(f.p, big).toString(),
    });
    await expectConstraintFailure("spend", inputs, { template: "Num2Bits", caller: { template: "Spend", statement: "valueBits.in <== value;" } });
  });

  it("wrong nullifier hash (PRIV-03 binding)", async () => {
    const other = nullifierHash(f.p, { nullifierSecret: f.noteA.nullifierSecret + 1n, label: f.noteA.label });
    await expectConstraintFailure("spend", withInputs(valid, { nullifierHash: other.toString() }), {
      template: "Spend",
      statement: "nullifier.out === nullifierHash;",
    });
  });

  it("label zero, even with an empty approved-tree slot as its membership path", async () => {
    const zeroNote: Note = { ...f.noteA, label: 0n, ...secretsAt(SEED, 21) };
    const tree = new MerkleTree(f.p, TREE_DEPTH);
    const idx = tree.append(commitment(f.p, zeroNote));
    const emptySlot = f.approved.path(f.approved.size);
    const inputs = withInputs(valid, {
      label: "0",
      nullifierSecret: zeroNote.nullifierSecret.toString(),
      noteSecret: zeroNote.noteSecret.toString(),
      stateRoot: tree.root.toString(),
      stateIndex: String(idx),
      stateSiblings: tree.path(idx).siblings.map(String),
      approvedIndex: String(emptySlot.index),
      approvedSiblings: emptySlot.siblings.map(String),
      nullifierHash: nullifierHash(f.p, zeroNote).toString(),
    });
    await expectConstraintFailure("spend", inputs, { template: "Spend", statement: "labelIsZero.out === 0;" });
  });

  it("unapproved label (PRIV-06 private path)", async () => {
    const statePath = f.state.path(1);
    const anyApproved = f.approved.path(0);
    const inputs = withInputs(valid, {
      value: f.noteU.value.toString(),
      label: f.noteU.label.toString(),
      nullifierSecret: f.noteU.nullifierSecret.toString(),
      noteSecret: f.noteU.noteSecret.toString(),
      stateIndex: String(statePath.index),
      stateSiblings: statePath.siblings.map(String),
      approvedIndex: String(anyApproved.index),
      approvedSiblings: anyApproved.siblings.map(String),
      nullifierHash: nullifierHash(f.p, f.noteU).toString(),
    });
    await expectConstraintFailure("spend", inputs, {
      template: "Spend",
      statement: "approvedMerkle.root === approvedRoot;",
    });
  });

  it("change nullifier secret equal to the parent's", async () => {
    await expectConstraintFailure(
      "spend",
      withInputs(valid, { newNullifierSecret: f.noteA.nullifierSecret.toString() }),
      { template: "Spend", statement: "sameSecret.out === 0;" },
    );
  });

  it("change commitment with another label or an inflated value", async () => {
    const otherLabel = commitment(f.p, { ...valid.changeNote, label: f.labels[0]! });
    const inflated = commitment(f.p, { ...valid.changeNote, value: valid.changeNote.value + 1n });
    for (const c of [otherLabel, inflated]) {
      await expectConstraintFailure("spend", withInputs(valid, { newCommitment: c.toString() }), {
        template: "Spend",
        statement: "change.commitment === newCommitment;",
      });
    }
  });

  it("state index outside 2^16", async () => {
    await expectConstraintFailure("spend", withInputs(valid, { stateIndex: String(1 << 16) }), { template: "Num2Bits", caller: { template: "MerkleRoot", statement: "bits.in <== index;", file: MERKLE } });
  });
});
