import { resolve } from "node:path";
import { CIRCUITS_DIR } from "../scripts/lib";
import { beforeAll, describe, expect, it } from "vitest";
import { commitment, insertWitness, secretsAt, verifyProof, type CircuitWitness, type GeneratedProof } from "@veilo/privacy-sdk";
import { expectConstraintFailure, getFixture, proveCircuit, SEED, verificationKey, withInputs, type Fixture } from "./helpers";

let f: Fixture;
let valid: CircuitWitness;
let proof: GeneratedProof;
let nextIndex: number;

beforeAll(async () => {
  f = await getFixture();
  nextIndex = f.state.size;
  const leaf = commitment(f.p, { value: 250_000n, label: f.labels[1]!, ...secretsAt(SEED, 30) });
  valid = insertWitness(f.p, { path: f.state.path(nextIndex), leaf });
  proof = await proveCircuit("insert", valid);
});

describe("insert: valid proof", () => {
  it("accepts a real one-leaf append at the next index under the current root", async () => {
    expect(valid.publicSignals[0]).toBe(f.state.root);
    expect(valid.publicSignals[2]).toBe(BigInt(nextIndex));
    expect(await verifyProof(verificationKey("insert"), proof.publicSignals, proof.proof)).toBe(true);
  });
});

describe("insert: proof-level rejections (PRIV-05)", () => {
  it("rejects a different old root, new root, leaf index or leaf", async () => {
    for (let i = 0; i < 4; i++) {
      const signals = [...proof.publicSignals];
      signals[i] = (BigInt(signals[i]!) + 1n).toString();
      expect(await verifyProof(verificationKey("insert"), signals, proof.proof)).toBe(false);
    }
  });

  it("rejects the proof with old and new roots swapped", async () => {
    const [o, n, i, l] = proof.publicSignals as [string, string, string, string];
    expect(await verifyProof(verificationKey("insert"), [n, o, i, l], proof.proof)).toBe(false);
  });
});

describe("insert: constraint failures", () => {
  it("overwriting an occupied slot (the slot is not empty under oldRoot)", async () => {
    const occupied = f.state.path(0);
    const w = withInputs(valid, { leafIndex: "0", siblings: occupied.siblings.map(String) });
    await expectConstraintFailure("insert", w, { template: "Insert", statement: "before.root === oldRoot;" });
  });

  it("a stale old root", async () => {
    await expectConstraintFailure("insert", withInputs(valid, { oldRoot: f.state.zeros[16]!.toString() }), {
      template: "Insert",
      statement: "before.root === oldRoot;",
    });
  });

  it("a forged new root", async () => {
    await expectConstraintFailure("insert", withInputs(valid, { newRoot: f.state.root.toString() }), {
      template: "Insert",
      statement: "after.root === newRoot;",
    });
  });

  it("a zero leaf", async () => {
    await expectConstraintFailure("insert", withInputs(valid, { leaf: "0" }), {
      template: "Insert",
      statement: "leafIsZero.out === 0;",
    });
  });

  it("a leaf index outside 2^16", async () => {
    await expectConstraintFailure("insert", withInputs(valid, { leafIndex: String((1 << 16) + nextIndex) }), {
      template: "Num2Bits",
      caller: { template: "MerkleRoot", statement: "bits.in <== index;", file: resolve(CIRCUITS_DIR, "src/lib/merkle.circom") },
    });
  });
});
