/** BN254 scalar field modulus r. Every circuit signal, Poseidon input and public input is in [0, r). */
export const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** BN254 base field modulus q (G1/G2 coordinates). */
export const BASE_FIELD_MODULUS = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

export const U64_MAX = (1n << 64n) - 1n;

export class EncodingError extends Error {
  override readonly name = "EncodingError";
}

export function isFieldElement(x: bigint): boolean {
  return x >= 0n && x < FIELD_MODULUS;
}

export function assertFieldElement(x: bigint, what = "field element"): bigint {
  if (!isFieldElement(x)) throw new EncodingError(`${what} is not in [0, r)`);
  return x;
}

export function assertU64(x: bigint, what = "u64"): bigint {
  if (x < 0n || x > U64_MAX) throw new EncodingError(`${what} is not in [0, 2^64)`);
  return x;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex");
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new EncodingError("hex must be lowercase with an even length");
  return new Uint8Array(Buffer.from(hex, "hex"));
}

/** Unsigned big-endian integer of arbitrary length. */
export function intBe(bytes: Uint8Array): bigint {
  return bytes.length === 0 ? 0n : BigInt(`0x${bytesToHex(bytes)}`);
}

function fixedBe(x: bigint, length: number): Uint8Array {
  const hex = x.toString(16);
  if (hex.length > length * 2) throw new EncodingError(`value does not fit in ${length} bytes`);
  return hexToBytes(hex.padStart(length * 2, "0"));
}

/** Canonical 32-byte big-endian encoding of a field element. Throws unless 0 <= x < r. */
export function toBe32(x: bigint): Uint8Array {
  return fixedBe(assertFieldElement(x), 32);
}

/** Inverse of toBe32. Throws unless the input is exactly 32 bytes and its value is < r. */
export function fromBe32(bytes: Uint8Array): bigint {
  if (bytes.length !== 32) throw new EncodingError("field element must be exactly 32 bytes");
  const x = intBe(bytes);
  if (x >= FIELD_MODULUS) throw new EncodingError("field element is not canonical (>= r)");
  return x;
}

export function isCanonicalBe32(bytes: Uint8Array): boolean {
  try {
    fromBe32(bytes);
    return true;
  } catch {
    return false;
  }
}

/** 8-byte big-endian u64, used in hash preimages. */
export function u64Be(x: bigint): Uint8Array {
  return fixedBe(assertU64(x), 8);
}

/** Parses a decimal string (as in snarkjs signals and vectors) into a bigint. */
export function parseDecimal(s: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(s)) throw new EncodingError(`not a canonical decimal: ${s}`);
  return BigInt(s);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Requires a raw 32-byte key or hash (e.g. a decoded Solana address). */
export function assertBytes32(bytes: Uint8Array, what: string): Uint8Array {
  if (bytes.length !== 32) throw new EncodingError(`${what} must be exactly 32 bytes`);
  return bytes;
}
