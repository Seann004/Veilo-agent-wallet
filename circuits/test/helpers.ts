import { readFileSync } from "node:fs";
import { groth16, wtns, type CircuitInputs, type Groth16Proof, type VerificationKey } from "snarkjs";
import {
  commitment,
  deriveLabel,
  draftIntent,
  DRAFT_CTX,
  getPoseidon,
  intentContext,
  labelCases,
  MerkleTree,
  prove,
  secretsAt,
  TREE_DEPTH,
  type CircuitWitness,
  type GeneratedProof,
  type Note,
  type Poseidon,
  type ProvingArtifacts,
} from "@veilo/privacy-sdk";
import { artifactPaths, MANIFEST_PATH, readJson, sourcePath, type MainCircuit } from "../scripts/lib";

interface ManifestCircuit {
  wasmSha256: string;
  zkeySha256: string;
  vkeyJsonSha256: string;
  publicInputOrder: string[];
  nPublic: number;
  constraints: number;
}

export function manifestCircuit(name: MainCircuit): ManifestCircuit {
  return readJson<{ circuits: Record<string, ManifestCircuit> }>(MANIFEST_PATH).circuits[name]!;
}

export function provingArtifacts(name: MainCircuit): ProvingArtifacts {
  const m = manifestCircuit(name);
  const p = artifactPaths(name);
  return { wasmPath: p.wasm, wasmSha256: m.wasmSha256, zkeyPath: p.zkey, zkeySha256: m.zkeySha256 };
}

export function verificationKey(name: MainCircuit): VerificationKey {
  return readJson<VerificationKey>(artifactPaths(name).vkeyJson);
}

export function proveCircuit(name: MainCircuit, w: CircuitWitness): Promise<GeneratedProof> {
  return prove(w, provingArtifacts(name));
}

/** Raw snarkjs verification (no canonical-signal pre-check). */
export function rawVerify(name: MainCircuit, publicSignals: string[], proof: Groth16Proof): Promise<boolean> {
  return groth16.verify(verificationKey(name), publicSignals, proof);
}

/** Runs the circuit's witness generator, which evaluates every constraint. Returns the witness. */
export async function calculateWitness(wasmPath: string, inputs: CircuitInputs): Promise<bigint[]> {
  const out = { type: "mem" as const };
  await wtns.calculate(inputs, new Uint8Array(readFileSync(wasmPath)), out);
  return wtns.exportJson(out);
}

/** Line number (1-based) of a unique statement in a circuit source, for asserting which constraint failed. */
export function lineOf(file: string, statement: string): number {
  const lines = readFileSync(file, "utf8").split("\n");
  const hits = lines.flatMap((l, i) => (l.includes(statement) ? [i + 1] : []));
  if (hits.length !== 1) throw new Error(`statement "${statement}" found ${hits.length} times in ${file}`);
  return hits[0]!;
}

/** Expects witness generation to fail on the given constraint. */
export async function expectConstraintFailure(
  name: MainCircuit,
  inputs: CircuitInputs,
  where: { template: string; statement?: string; file?: string; caller?: { template: string; statement: string; file?: string } },
): Promise<void> {
  let error: unknown;
  try {
    await calculateWitness(artifactPaths(name).wasm, inputs);
  } catch (e) {
    error = e;
  }
  if (error === undefined) throw new Error(`witness for ${name} unexpectedly satisfied all constraints`);
  const msg = String((error as Error).message ?? error);
  if (!msg.includes("Assert Failed")) throw new Error(`unexpected witness error: ${msg}`);
  const line = where.statement === undefined ? undefined : lineOf(where.file ?? sourcePath(name), where.statement);
  const pattern = new RegExp(`template ${where.template}_\\d+ line: ${line ?? "\\d+"}`);
  if (!pattern.test(msg)) throw new Error(`expected failure at ${pattern}, got: ${msg}`);
  if (where.caller !== undefined) {
    const c = where.caller;
    const callerLine = lineOf(c.file ?? sourcePath(name), c.statement);
    const callerPattern = new RegExp(`template ${c.template}_\\d+ line: ${callerLine}\\b`);
    if (!callerPattern.test(msg)) throw new Error(`expected call site ${callerPattern}, got: ${msg}`);
  }
}

export function withInputs(w: CircuitWitness, patch: Record<string, string | string[]>): CircuitInputs {
  return { ...w.inputs, ...patch };
}

export const SEED = Uint8Array.from({ length: 32 }, (_, i) => i);

export interface Fixture {
  p: Poseidon;
  labels: bigint[];
  /** Approved owner note (label of the setup wallet). */
  noteA: Note;
  /** Note whose label is not in the approved tree. */
  noteU: Note;
  state: MerkleTree;
  approved: MerkleTree;
  approvedIndexA: number;
  context: (payout: bigint, fee?: bigint) => bigint;
}

let fixture: Promise<Fixture> | undefined;

export function getFixture(): Promise<Fixture> {
  fixture ??= (async () => {
    const p = await getPoseidon();
    const labels = labelCases().map((c) => deriveLabel(c).label);
    const noteA: Note = { value: 1_000_000n, label: labels[1]!, ...secretsAt(SEED, 0) };
    const noteU: Note = { value: 500_000n, label: labels[2]!, ...secretsAt(SEED, 10) };
    const state = new MerkleTree(p, TREE_DEPTH);
    state.append(commitment(p, noteA));
    state.append(commitment(p, noteU));
    const approved = new MerkleTree(p, TREE_DEPTH);
    approved.append(labels[0]!);
    const approvedIndexA = approved.append(labels[1]!);
    const context = (payout: bigint, fee = 0n) =>
      intentContext(
        DRAFT_CTX,
        draftIntent(
          fee === 0n
            ? { payoutAmount: payout }
            : { payoutAmount: payout, relayerFee: fee, relayer: new Uint8Array(32).fill(0x77), relayerFeeTokenAccount: new Uint8Array(32).fill(0x88) },
        ),
      ).context;
    return { p, labels, noteA, noteU, state, approved, approvedIndexA, context };
  })();
  return fixture;
}
