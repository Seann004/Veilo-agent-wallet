import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { groth16, type Groth16Proof, type VerificationKey } from "snarkjs";
import { BASE_FIELD_MODULUS, bytesToHex, concatBytes, EncodingError, isFieldElement, parseDecimal, toBe32 } from "./field";
import type { CircuitWitness } from "./witness";

export class ArtifactMismatchError extends Error {
  override readonly name = "ArtifactMismatchError";
}

/** Content-addressed proving files for one circuit. */
export interface ProvingArtifacts {
  wasmPath: string;
  wasmSha256: string;
  zkeyPath: string;
  zkeySha256: string;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Reads a file and refuses to return it unless its SHA-256 equals the pinned value. */
export async function readPinned(path: string, expectedSha256: string): Promise<Uint8Array> {
  const bytes = new Uint8Array(await readFile(path));
  const actual = sha256Hex(bytes);
  if (actual !== expectedSha256) {
    throw new ArtifactMismatchError(`${path}: sha256 ${actual} does not match pinned ${expectedSha256}`);
  }
  return bytes;
}

export interface GeneratedProof {
  proof: Groth16Proof;
  publicSignals: string[];
}

/** Proves with hash-verified artifacts and checks that the public signals match the witness. */
export async function prove(witness: CircuitWitness, artifacts: ProvingArtifacts): Promise<GeneratedProof> {
  const wasm = await readPinned(artifacts.wasmPath, artifacts.wasmSha256);
  const zkey = await readPinned(artifacts.zkeyPath, artifacts.zkeySha256);
  const { proof, publicSignals } = await groth16.fullProve(witness.inputs, wasm, zkey);
  const expected = witness.publicSignals.map((x) => x.toString(10));
  if (publicSignals.length !== expected.length || publicSignals.some((s, i) => s !== expected[i])) {
    throw new EncodingError("prover public signals differ from the witness public inputs");
  }
  return { proof, publicSignals };
}

/**
 * Off-chain verification. Public signals must be canonical decimals below r, matching the
 * on-chain `verify()` check, before snarkjs runs the pairing check.
 */
export async function verifyProof(vk: VerificationKey, publicSignals: string[], proof: Groth16Proof): Promise<boolean> {
  if (publicSignals.length !== vk.nPublic) return false;
  for (const s of publicSignals) {
    let x: bigint;
    try {
      x = parseDecimal(s);
    } catch {
      return false;
    }
    if (!isFieldElement(x)) return false;
  }
  return groth16.verify(vk, publicSignals, proof);
}

/** Proof bytes for groth16-solana: A negated, G1 as x||y, G2 as x.c1||x.c0||y.c1||y.c0, all 32-byte big-endian. */
export interface SolanaProof {
  a: Uint8Array;
  b: Uint8Array;
  c: Uint8Array;
}

function coord(s: string | undefined): bigint {
  if (s === undefined) throw new EncodingError("missing proof coordinate");
  const x = parseDecimal(s);
  if (x >= BASE_FIELD_MODULUS) throw new EncodingError("proof coordinate is not below q");
  return x;
}

function be32q(x: bigint): Uint8Array {
  return new Uint8Array(Buffer.from(x.toString(16).padStart(64, "0"), "hex"));
}

function g1(p: string[]): Uint8Array {
  return concatBytes(be32q(coord(p[0])), be32q(coord(p[1])));
}

function g2(p: string[][]): Uint8Array {
  const [x, y] = [p[0] ?? [], p[1] ?? []];
  return concatBytes(be32q(coord(x[1])), be32q(coord(x[0])), be32q(coord(y[1])), be32q(coord(y[0])));
}

export function negateG1(p: string[]): string[] {
  const y = coord(p[1]);
  return [p[0] ?? "", (y === 0n ? 0n : BASE_FIELD_MODULUS - y).toString(10), ...p.slice(2)];
}

export function toSolanaProof(proof: Groth16Proof): SolanaProof {
  return { a: g1(negateG1(proof.pi_a)), b: g2(proof.pi_b), c: g1(proof.pi_c) };
}

export function publicInputsBytes(publicSignals: string[]): Uint8Array[] {
  return publicSignals.map((s) => toBe32(parseDecimal(s)));
}

/** Hex view used by the cross-language groth16 vectors. */
export function solanaProofHex(proof: Groth16Proof): { a: string; b: string; c: string } {
  const p = toSolanaProof(proof);
  return { a: bytesToHex(p.a), b: bytesToHex(p.b), c: bytesToHex(p.c) };
}

export function vkG1(p: string[]): Uint8Array {
  return g1(p);
}

export function vkG2(p: string[][]): Uint8Array {
  return g2(p);
}
