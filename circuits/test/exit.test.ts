import { beforeAll, describe, expect, it } from "vitest";
import {
  commitment,
  exitWitness,
  MerkleTree,
  nullifierHash,
  precommitment,
  secretsAt,
  spendWitness,
  TREE_DEPTH,
  verifyProof,
  type CircuitWitness,
  type GeneratedProof,
  type Note,
} from "@veilo/privacy-sdk";
import { expectConstraintFailure, getFixture, proveCircuit, SEED, verificationKey, withInputs, type Fixture } from "./helpers";

let f: Fixture;
let valid: CircuitWitness;
let proof: GeneratedProof;

beforeAll(async () => {
  f = await getFixture();
  valid = exitWitness(f.p, { note: f.noteA, statePath: f.state.path(0) });
  proof = await proveCircuit("exit", valid);
});

describe("exit: valid proofs (PRIV-06)", () => {
  it("accepts a real exit of an original note with its program-derived label", async () => {
    expect(valid.publicSignals[1]).toBe(f.noteA.label);
    expect(await verifyProof(verificationKey("exit"), proof.publicSignals, proof.proof)).toBe(true);
  });

  it("accepts a real exit of an unapproved note (no approved-set input)", async () => {
    const w = exitWitness(f.p, { note: f.noteU, statePath: f.state.path(1) });
    const p = await proveCircuit("exit", w);
    expect(await verifyProof(verificationKey("exit"), p.publicSignals, p.proof)).toBe(true);
  });

  it("accepts a real exit of a change note, which carries the original label", async () => {
    const spend = spendWitness(f.p, {
      note: f.noteA,
      statePath: f.state.path(0),
      approvedPath: f.approved.path(f.approvedIndexA),
      context: f.context(300_000n),
      withdrawnValue: 300_000n,
      change: secretsAt(SEED, 40),
    });
    const tree = new MerkleTree(f.p, TREE_DEPTH);
    for (let i = 0; i < f.state.size; i++) tree.append(f.state.leaf(i));
    const idx = tree.append(spend.newCommitment);
    const w = exitWitness(f.p, { note: spend.changeNote, statePath: tree.path(idx) });
    expect(w.publicSignals[1]).toBe(f.noteA.label);
    expect(w.publicSignals[2]).toBe(700_000n);
    const p = await proveCircuit("exit", w);
    expect(await verifyProof(verificationKey("exit"), p.publicSignals, p.proof)).toBe(true);
  });
});

describe("exit: rejections", () => {
  it("EXIT-01: a valid proof re-checked with the label derived from another signer is rejected", async () => {
    const attackerLabel = f.labels[2]!;
    expect(attackerLabel).not.toBe(f.noteA.label);
    const signals = [...proof.publicSignals];
    signals[1] = attackerLabel.toString();
    expect(await verifyProof(verificationKey("exit"), signals, proof.proof)).toBe(false);
  });

  it("EXIT-01: no witness exists for the owner's note under another signer's label", async () => {
    await expectConstraintFailure("exit", withInputs(valid, { label: f.labels[2]!.toString() }), {
      template: "Exit",
      statement: "merkle.root === stateRoot;",
    });
  });

  it("rejects a changed disclosed value, root or nullifier at proof level", async () => {
    for (const i of [0, 2, 3]) {
      const signals = [...proof.publicSignals];
      signals[i] = (BigInt(signals[i]!) + 1n).toString();
      expect(await verifyProof(verificationKey("exit"), signals, proof.proof)).toBe(false);
    }
  });

  it("disclosing a larger value than the note holds", async () => {
    await expectConstraintFailure("exit", withInputs(valid, { value: (f.noteA.value + 1n).toString() }), {
      template: "Exit",
      statement: "merkle.root === stateRoot;",
    });
  });

  it("a value of 2^64 fails the range check even if committed", async () => {
    const big: Note = { ...f.noteA, value: 1n << 64n, ...secretsAt(SEED, 41) };
    const tree = new MerkleTree(f.p, TREE_DEPTH);
    // The SDK refuses to build this leaf; an attacker would hash it directly.
    const idx = tree.append(f.p.h3(big.value, big.label, precommitment(f.p, big)));
    const inputs = withInputs(valid, {
      stateRoot: tree.root.toString(),
      value: big.value.toString(),
      nullifierSecret: big.nullifierSecret.toString(),
      noteSecret: big.noteSecret.toString(),
      index: String(idx),
      siblings: tree.path(idx).siblings.map(String),
      nullifierHash: nullifierHash(f.p, big).toString(),
    });
    await expectConstraintFailure("exit", inputs, { template: "Num2Bits", caller: { template: "Exit", statement: "valueBits.in <== value;" } });
  });

  it("wrong nullifier hash", async () => {
    const other = nullifierHash(f.p, { nullifierSecret: f.noteA.nullifierSecret, label: f.labels[0]! });
    await expectConstraintFailure("exit", withInputs(valid, { nullifierHash: other.toString() }), {
      template: "Exit",
      statement: "nullifier.out === nullifierHash;",
    });
  });

  it("wrong state root", async () => {
    await expectConstraintFailure("exit", withInputs(valid, { stateRoot: f.state.zeros[TREE_DEPTH]!.toString() }), {
      template: "Exit",
      statement: "merkle.root === stateRoot;",
    });
  });

  it("label zero", async () => {
    const zeroNote: Note = { ...f.noteA, label: 0n, ...secretsAt(SEED, 42) };
    const tree = new MerkleTree(f.p, TREE_DEPTH);
    const idx = tree.append(commitment(f.p, zeroNote));
    const inputs = withInputs(valid, {
      stateRoot: tree.root.toString(),
      label: "0",
      nullifierSecret: zeroNote.nullifierSecret.toString(),
      noteSecret: zeroNote.noteSecret.toString(),
      index: String(idx),
      siblings: tree.path(idx).siblings.map(String),
      nullifierHash: nullifierHash(f.p, zeroNote).toString(),
    });
    await expectConstraintFailure("exit", inputs, { template: "Exit", statement: "labelIsZero.out === 0;" });
  });

  it("spend and exit derive the same nullifier for a note (shared namespace)", () => {
    const spend = spendWitness(f.p, {
      note: f.noteA,
      statePath: f.state.path(0),
      approvedPath: f.approved.path(f.approvedIndexA),
      context: f.context(1n),
      withdrawnValue: 1n,
      change: secretsAt(SEED, 43),
    });
    expect(spend.publicSignals[3]).toBe(valid.publicSignals[3]);
  });
});
