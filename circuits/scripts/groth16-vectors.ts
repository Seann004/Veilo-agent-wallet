// Proves one sample per circuit from artifacts/vectors/v1.json, writes the groth16 cross-language
// vectors (valid and mutated cases) and records proving measurements for this host.
//
//   tsx circuits/scripts/groth16-vectors.ts [--force]
//
// Groth16 proofs are randomized, so the file is regenerated only when a proving key changes.
import { cpus, platform, release, totalmem } from "node:os";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { groth16, wtns } from "snarkjs";
import {
  bytesToHex,
  exitWitness,
  FIELD_MODULUS,
  getPoseidon,
  insertWitness,
  parseDecimal,
  publicInputsBytes,
  readPinned,
  spendWitness,
  toSolanaProof,
  verifyProof,
  type CircuitWitness,
  type Note,
  type VectorsV1,
} from "@veilo/privacy-sdk";
import {
  ARTIFACTS_DIR,
  artifactPaths,
  GROTH16_VECTORS_PATH,
  MAIN_CIRCUITS,
  MANIFEST_PATH,
  readJson,
  stableJson,
  VECTORS_PATH,
  type MainCircuit,
} from "./lib";

const RUNS = 3;
const MEASUREMENTS_PATH = resolve(ARTIFACTS_DIR, "measurements.json");

interface ManifestCircuit {
  wasmSha256: string;
  zkeySha256: string;
  vkeyJsonSha256: string;
  constraints: number;
}
const manifest = readJson<{ circuits: Record<MainCircuit, ManifestCircuit> }>(MANIFEST_PATH);

if (existsSync(GROTH16_VECTORS_PATH) && !process.argv.includes("--force")) {
  const prev = readJson<{ circuits: Record<string, { zkeySha256: string }> }>(GROTH16_VECTORS_PATH);
  if (MAIN_CIRCUITS.every((c) => prev.circuits[c]?.zkeySha256 === manifest.circuits[c].zkeySha256)) {
    console.log("[circuits] groth16 vectors are current");
    process.exit(0);
  }
}

const v = readJson<VectorsV1>(VECTORS_PATH);
const p = await getPoseidon();
const big = (s: string) => parseDecimal(s);
const noteOf = (n: { value: string; label: string; nullifierSecret: string; noteSecret: string }): Note => ({
  value: big(n.value),
  label: big(n.label),
  nullifierSecret: big(n.nullifierSecret),
  noteSecret: big(n.noteSecret),
});
const pathOf = (x: { index: number; siblings: string[] }) => ({ index: x.index, siblings: x.siblings.map(big) });

function samples(): Record<MainCircuit, CircuitWitness> {
  const n0 = v.note[0]!;
  const full = n0.changes[1]!;
  const intent = v.intent.valid[0]!;
  const spend = spendWitness(p, {
    note: noteOf(n0),
    statePath: pathOf(v.merkle.state.paths[0]!),
    approvedPath: pathOf(v.merkle.approved.paths[0]!),
    context: big(intent.context),
    withdrawnValue: big(intent.withdrawnValue),
    change: { nullifierSecret: big(full.nullifierSecret), noteSecret: big(full.noteSecret) },
  });
  if (spend.newCommitment !== big(full.commitment)) throw new Error("spend sample does not match the change vector");
  const step = v.insert[0]!;
  const insert = insertWitness(p, { path: { index: step.leafIndex!, siblings: step.siblings!.map(big) }, leaf: big(step.leaf!) });
  const exit = exitWitness(p, { note: noteOf(n0), statePath: pathOf(v.merkle.state.paths[0]!) });
  return { spend, insert, exit };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const round = (x: number) => Math.round(x);

const out: Record<string, unknown> = {};
const measurements: Record<string, unknown> = {};
const witnesses = samples();

for (const name of MAIN_CIRCUITS) {
  const m = manifest.circuits[name];
  const paths = artifactPaths(name);
  const wasm = await readPinned(paths.wasm, m.wasmSha256);
  const zkey = await readPinned(paths.zkey, m.zkeySha256);
  const vk = readJson<Parameters<typeof groth16.verify>[0]>(paths.vkeyJson);
  const w = witnesses[name];

  const witnessMs: number[] = [];
  const proveMs: number[] = [];
  const verifyMs: number[] = [];
  let last: Awaited<ReturnType<typeof groth16.fullProve>> | undefined;
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    const wt = { type: "mem" as const };
    await wtns.calculate(w.inputs, wasm, wt);
    const t1 = performance.now();
    const res = await groth16.fullProve(w.inputs, wasm, zkey);
    const t2 = performance.now();
    if (!(await verifyProof(vk, res.publicSignals, res.proof))) throw new Error(`${name}: proof did not verify`);
    const t3 = performance.now();
    witnessMs.push(t1 - t0);
    proveMs.push(t2 - t1);
    verifyMs.push(t3 - t2);
    last = res;
  }
  const { proof, publicSignals } = last!;
  if (publicSignals.join() !== w.publicSignals.join()) throw new Error(`${name}: unexpected public signals`);
  const sol = toSolanaProof(proof);
  const inputs = publicInputsBytes(publicSignals).map(bytesToHex);
  const hexes = { a: bytesToHex(sol.a), b: bytesToHex(sol.b), c: bytesToHex(sol.c) };

  // Mutations that must fail in every verifier.
  const plusOne = [...inputs];
  plusOne[inputs.length - 1] = (big(publicSignals[inputs.length - 1]!) + 1n).toString(16).padStart(64, "0");
  // Index 3 is nullifierHash (spend, exit) or leaf (insert): a replay key or a queue binding.
  const aliasIdx = 3;
  const plusR = [...inputs];
  plusR[aliasIdx] = (big(publicSignals[aliasIdx]!) + FIELD_MODULUS).toString(16).padStart(64, "0");
  const unnegatedA = bytesToHex(
    new Uint8Array(Buffer.from(BigInt(proof.pi_a[0]!).toString(16).padStart(64, "0") + BigInt(proof.pi_a[1]!).toString(16).padStart(64, "0"), "hex")),
  );
  const b = hexes.b;
  const swappedB = b.slice(64, 128) + b.slice(0, 64) + b.slice(192, 256) + b.slice(128, 192);

  out[name] = {
    zkeySha256: m.zkeySha256,
    vkeyJsonSha256: m.vkeyJsonSha256,
    snarkjs: { proof, publicSignals },
    valid: { ...hexes, publicInputs: inputs },
    invalid: [
      { name: "last public input + 1", ...hexes, publicInputs: plusOne, error: "ProofVerificationFailed" },
      { name: `public input ${aliasIdx} + r (non-canonical alias)`, ...hexes, publicInputs: plusR, error: "PublicInputGreaterThanFieldSize" },
      { name: "proof_a not negated", ...hexes, a: unnegatedA, publicInputs: inputs, error: "ProofVerificationFailed" },
      { name: "proof_b with c0/c1 halves swapped", ...hexes, b: swappedB, publicInputs: inputs, error: "ProofVerificationFailed" },
    ],
  };
  measurements[name] = {
    constraints: m.constraints,
    publicInputs: publicSignals.length,
    proofBytes: sol.a.length + sol.b.length + sol.c.length,
    publicInputBytes: 32 * publicSignals.length,
    zkeyBytes: readFileSync(paths.zkey).length,
    wasmBytes: wasm.length,
    runs: RUNS,
    witnessMsMedian: round(median(witnessMs)),
    fullProveMsMedian: round(median(proveMs)),
    fullProveMsAll: proveMs.map(round),
    snarkjsVerifyMsMedian: round(median(verifyMs)),
  };
  console.log(`[circuits] ${name}: fullProve median ${round(median(proveMs))} ms over ${RUNS} runs`);
}

writeFileSync(
  GROTH16_VECTORS_PATH,
  stableJson({
    version: "v1",
    generatedBy: "circuits/scripts/groth16-vectors.ts; regenerated only when a proving key changes",
    encoding: "proof a = be32(A.x)||be32(q - A.y); b = x.c1||x.c0||y.c1||y.c0; c = x||y; public inputs be32",
    circuits: out,
  }),
);
writeFileSync(
  MEASUREMENTS_PATH,
  stableJson({
    measuredAt: new Date().toISOString(),
    host: {
      platform: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model ?? "unknown",
      logicalCpus: cpus().length,
      memoryGiB: Math.round(totalmem() / 2 ** 30),
      node: process.version,
      prover: "snarkjs 0.7.6 groth16.fullProve (WASM witness, JS prover)",
    },
    circuits: measurements,
  }),
);
console.log("[circuits] wrote artifacts/vectors/groth16-v1.json and artifacts/circuits/measurements.json");

// snarkjs keeps curve worker threads alive; exit explicitly once all files are written.
process.exit(0);
