import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ArtifactMismatchError, PUBLIC_INPUTS, prove, readPinned, sha256Hex } from "@veilo/privacy-sdk";
import { artifactPaths, MAIN_CIRCUITS, MANIFEST_PATH, readJson, sha256File, sourceFiles, sourcePath, sourceTreeHash } from "../scripts/lib";
import { manifestCircuit, provingArtifacts } from "./helpers";

/** Wire index of each `main.<signal>` from circom's .sym file (labelIdx,varIdx,componentIdx,name). */
function mainWires(name: string): Map<string, number> {
  const wires = new Map<string, number>();
  for (const line of readFileSync(artifactPaths(name).sym, "utf8").split("\n")) {
    const [, varIdx, , signal] = line.split(",");
    if (signal?.startsWith("main.") && !signal.slice(5).includes(".")) wires.set(signal.slice(5), Number(varIdx));
  }
  return wires;
}

describe("public input order", () => {
  for (const name of MAIN_CIRCUITS) {
    it(`${name}: wires 1..n of the compiled circuit are the declared public inputs, in order`, () => {
      const wires = mainWires(name);
      const order = PUBLIC_INPUTS[name];
      order.forEach((signal, i) => expect(wires.get(signal), signal).toBe(i + 1));
      // No other main signal occupies a public wire, so there are no public outputs.
      const publicWires = [...wires.entries()].filter(([, idx]) => idx >= 1 && idx <= order.length);
      expect(publicWires.map(([s]) => s).sort()).toEqual([...order].sort());
      const m = manifestCircuit(name);
      expect(m.publicInputOrder).toEqual([...order]);
      expect(m.nPublic).toBe(order.length);
      const vk = readJson<{ nPublic: number; IC: unknown[] }>(artifactPaths(name).vkeyJson);
      expect(vk.nPublic).toBe(order.length);
      expect(vk.IC).toHaveLength(order.length + 1);
    });
  }
});

describe("content-addressed artifacts", () => {
  for (const name of MAIN_CIRCUITS) {
    it(`${name}: built files match the manifest hashes`, () => {
      const m = readJson<{ circuits: Record<string, Record<string, unknown>> }>(MANIFEST_PATH).circuits[name]!;
      const p = artifactPaths(name);
      expect(sha256File(p.r1cs)).toBe(m.r1csSha256);
      expect(sha256File(p.wasm)).toBe(m.wasmSha256);
      expect(sha256File(p.zkey)).toBe(m.zkeySha256);
      expect(sha256File(p.vkeyJson)).toBe(m.vkeyJsonSha256);
      expect(sha256File(p.vkRust)).toBe(m.vkRustSha256);
      expect(sourceTreeHash(sourceFiles(sourcePath(name)))).toBe(m.sourceSha256);
    });
  }

  it("refuses to prove with a proving key whose hash differs from the pinned value", async () => {
    const pinned = provingArtifacts("insert");
    const tampered = { ...pinned, zkeySha256: sha256Hex(new Uint8Array([1])) };
    await expect(readPinned(tampered.zkeyPath, tampered.zkeySha256)).rejects.toBeInstanceOf(ArtifactMismatchError);
    await expect(prove({ inputs: {}, publicSignals: [] }, tampered)).rejects.toBeInstanceOf(ArtifactMismatchError);
    const swapped = { ...pinned, wasmPath: provingArtifacts("exit").wasmPath };
    await expect(prove({ inputs: {}, publicSignals: [] }, swapped)).rejects.toBeInstanceOf(ArtifactMismatchError);
  });
});
