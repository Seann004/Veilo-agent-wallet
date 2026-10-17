import { createHash } from "node:crypto";
import { getAddressEncoder, type Address } from "@solana/kit";
import { assertBytes32, concatBytes, EncodingError, intBe } from "./field";

export const LABEL_DOMAIN = "veilo/label/v1";
export const INTENT_DOMAIN = "veilo/intent/v1";

export function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

/** int_be(SHA256(bytes)[0..31]): a 248-bit value, always below r. */
export function sha256First31(bytes: Uint8Array): bigint {
  return intBe(sha256(bytes).subarray(0, 31));
}

export function ascii(s: string): Uint8Array {
  if (!/^[\x20-\x7e]*$/.test(s)) throw new EncodingError("domain tag must be printable ASCII");
  return new Uint8Array(Buffer.from(s, "ascii"));
}

/** Raw 32 bytes of a base58 Solana address. */
export function addressBytes(address: Address | string): Uint8Array {
  return new Uint8Array(getAddressEncoder().encode(address as Address));
}

export interface LabelInputs {
  /** PoolState account address (not pool_id). */
  pool: Uint8Array;
  mint: Uint8Array;
  refundAuthority: Uint8Array;
  salt: Uint8Array;
}

export interface LabelDerivation {
  preimage: Uint8Array;
  sha256: Uint8Array;
  label: bigint;
}

export function labelPreimage(inputs: LabelInputs): Uint8Array {
  return concatBytes(
    ascii(LABEL_DOMAIN),
    assertBytes32(inputs.pool, "pool"),
    assertBytes32(inputs.mint, "mint"),
    assertBytes32(inputs.refundAuthority, "refund authority"),
    assertBytes32(inputs.salt, "salt"),
  );
}

/** Derives the note label. Throws on the (unreachable in practice) zero label, which the program rejects. */
export function deriveLabel(inputs: LabelInputs): LabelDerivation {
  const preimage = labelPreimage(inputs);
  const digest = sha256(preimage);
  const label = intBe(digest.subarray(0, 31));
  if (label === 0n) throw new EncodingError("label is zero");
  return { preimage, sha256: digest, label };
}
