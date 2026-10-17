// Circom side of artifacts/vectors/v1.json: the compiled circuits reproduce the TypeScript
// reference for Poseidon, note derivations, zero values, Merkle paths and insert steps.
import { describe, expect, it } from "vitest";
import { insertWitness, exitWitness, getPoseidon, parseDecimal, type VectorsV1 } from "@veilo/privacy-sdk";
import { artifactPaths, readJson, VECTORS_PATH } from "../scripts/lib";
import { calculateWitness } from "./helpers";

const v = readJson<VectorsV1>(VECTORS_PATH);
const HASHES = artifactPaths("hashes").wasm;
const MERKLE = artifactPaths("merkle16").wasm;

/** Witness layout: w[0] = 1, then outputs in declaration order. */
async function hashes(input: { h2?: string[]; h3?: string[]; value?: string; label?: string; ns?: string; s?: string }) {
  const w = await calculateWitness(HASHES, {
    h2: input.h2 ?? ["0", "0"],
    h3: input.h3 ?? ["0", "0", "0"],
    value: input.value ?? "0",
    label: input.label ?? "0",
    nullifierSecret: input.ns ?? "0",
    noteSecret: input.s ?? "0",
  });
  return { h2: w[1]!, h3: w[2]!, precommitment: w[3]!, commitment: w[4]!, nullifierHash: w[5]! };
}

async function merkleRoot(leaf: string, index: number, siblings: string[]): Promise<bigint> {
  const w = await calculateWitness(MERKLE, { leaf, index: String(index), siblings });
  return w[1]!;
}

describe("circom reproduces the v1 vectors", () => {
  it("poseidon", async () => {
    for (const c of v.poseidon) {
      const out = c.fn === "H2" ? (await hashes({ h2: c.inputs })).h2 : (await hashes({ h3: c.inputs })).h3;
      expect(out).toBe(parseDecimal(c.output));
    }
  });

  it("note precommitment, commitment and nullifier hash, including change notes", async () => {
    for (const n of v.note) {
      for (const x of [n, ...n.changes]) {
        const out = await hashes({ value: x.value, label: x.label, ns: x.nullifierSecret, s: x.noteSecret });
        expect(out.precommitment).toBe(parseDecimal(x.precommitment));
        expect(out.commitment).toBe(parseDecimal(x.commitment));
        expect(out.nullifierHash).toBe(parseDecimal(x.nullifierHash));
      }
    }
  });

  it("zero values and the empty root", async () => {
    const zeros = v.zeros.map(parseDecimal);
    for (let i = 0; i < 16; i++) {
      expect((await hashes({ h2: [zeros[i]!.toString(), zeros[i]!.toString()] })).h2).toBe(zeros[i + 1]);
    }
    expect(await merkleRoot("0", 0, v.zeros.slice(0, 16))).toBe(parseDecimal(v.emptyRoot));
  });

  it("merkle paths of the state and approved trees", async () => {
    for (const t of [v.merkle.state, v.merkle.approved]) {
      for (const p of t.paths) {
        expect(await merkleRoot(p.leaf, p.index, p.siblings)).toBe(parseDecimal(t.root));
      }
    }
  });

  it("insert steps satisfy the insert circuit, including after a skipped refunded deposit", async () => {
    const p = await getPoseidon();
    let checked = 0;
    for (const step of v.insert) {
      if (step.skipped) continue;
      const w = insertWitness(p, { path: { index: step.leafIndex!, siblings: step.siblings!.map(parseDecimal) }, leaf: parseDecimal(step.leaf!) });
      expect(w.publicSignals.map(String)).toEqual([step.oldRoot, step.newRoot, String(step.leafIndex), step.leaf]);
      await calculateWitness(artifactPaths("insert").wasm, w.inputs);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("the original vector note satisfies the exit circuit against the vector state tree", async () => {
    const p = await getPoseidon();
    const n = v.note[0]!;
    const path = v.merkle.state.paths[0]!;
    expect(path.leaf).toBe(n.commitment);
    const w = exitWitness(p, {
      note: { value: BigInt(n.value), label: BigInt(n.label), nullifierSecret: BigInt(n.nullifierSecret), noteSecret: BigInt(n.noteSecret) },
      statePath: { index: path.index, siblings: path.siblings.map(parseDecimal) },
    });
    expect(w.publicSignals[0]!.toString()).toBe(v.merkle.state.root);
    await calculateWitness(artifactPaths("exit").wasm, w.inputs);
  });
});
