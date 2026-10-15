import { hkdfSync } from "node:crypto";
import { assertBytes32, EncodingError, FIELD_MODULUS, intBe } from "./field";
import { ascii } from "./label";

export type KeyKind = "nullifier" | "secret" | "salt" | "onetime";

const LENGTH: Record<KeyKind, number> = { nullifier: 64, secret: 64, salt: 32, onetime: 32 };

function assertIndex(index: number): void {
  if (!Number.isSafeInteger(index) || index < 0) throw new EncodingError("key index must be a non-negative integer");
}

/** HKDF-SHA256 with an empty salt and info `veilo/<kind>/v1/<index>` (decimal index). */
export function hkdfOutput(seed: Uint8Array, kind: KeyKind, index: number): Uint8Array {
  assertBytes32(seed, "note seed");
  assertIndex(index);
  const info = ascii(`veilo/${kind}/v1/${index}`);
  return new Uint8Array(hkdfSync("sha256", seed, new Uint8Array(0), info, LENGTH[kind]));
}

/** int_be(okm) mod r. Returns null for the (negligible) zero case, which callers skip to the next index. */
export function deriveFieldSecret(seed: Uint8Array, kind: "nullifier" | "secret", index: number): bigint | null {
  const x = intBe(hkdfOutput(seed, kind, index)) % FIELD_MODULUS;
  return x === 0n ? null : x;
}

export function deriveSalt(seed: Uint8Array, index: number): Uint8Array {
  return hkdfOutput(seed, "salt", index);
}

/** Ed25519 seed for one-time payment key j. */
export function deriveOneTimeSeed(seed: Uint8Array, index: number): Uint8Array {
  return hkdfOutput(seed, "onetime", index);
}
