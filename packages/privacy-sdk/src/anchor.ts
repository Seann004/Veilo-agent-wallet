import { getAddressDecoder, getAddressEncoder, type Address } from "@solana/kit";
import { EncodingError, U64_MAX } from "./field";
import { sha256 } from "./label";

/** Anchor 8-byte discriminators: sha256("<namespace>:<name>")[0..8]. */
export function anchorDiscriminator(namespace: "global" | "account" | "event", name: string): Uint8Array {
  return sha256(new Uint8Array(Buffer.from(`${namespace}:${name}`, "utf8"))).subarray(0, 8);
}

export const instructionDiscriminator = (ixName: string): Uint8Array => anchorDiscriminator("global", ixName);
export const accountDiscriminator = (accountName: string): Uint8Array => anchorDiscriminator("account", accountName);
export const eventDiscriminator = (eventName: string): Uint8Array => anchorDiscriminator("event", eventName);

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

const addrEnc = getAddressEncoder();
const addrDec = getAddressDecoder();

/** Borsh writer for the fixed-width types used by the pool program (u64 little-endian). */
export class BorshWriter {
  private readonly parts: Uint8Array[] = [];

  bytes(b: Uint8Array, length?: number): this {
    if (length !== undefined && b.length !== length) throw new EncodingError(`expected ${length} bytes, got ${b.length}`);
    this.parts.push(Uint8Array.from(b));
    return this;
  }

  u8(x: number): this {
    if (!Number.isInteger(x) || x < 0 || x > 255) throw new EncodingError("u8 out of range");
    return this.bytes(Uint8Array.of(x));
  }

  bool(x: boolean): this {
    return this.u8(x ? 1 : 0);
  }

  u64(x: bigint): this {
    if (x < 0n || x > U64_MAX) throw new EncodingError("u64 out of range");
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, x, true);
    return this.bytes(out);
  }

  pubkey(a: Address | string): this {
    return this.bytes(new Uint8Array(addrEnc.encode(a as Address)), 32);
  }

  option<T>(value: T | null | undefined, write: (w: this, v: T) => void): this {
    if (value === null || value === undefined) return this.u8(0);
    this.u8(1);
    write(this, value);
    return this;
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

/** Borsh reader; every read is bounds-checked and the caller asserts full consumption. */
export class BorshReader {
  private offset = 0;

  constructor(private readonly data: Uint8Array) {}

  get remaining(): number {
    return this.data.length - this.offset;
  }

  bytes(n: number): Uint8Array {
    if (this.offset + n > this.data.length) throw new EncodingError("account or event data is truncated");
    const out = this.data.slice(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  u8(): number {
    return this.bytes(1)[0]!;
  }

  bool(): boolean {
    const v = this.u8();
    if (v > 1) throw new EncodingError("invalid bool");
    return v === 1;
  }

  u64(): bigint {
    const b = this.bytes(8);
    return new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true);
  }

  pubkey(): Address {
    return addrDec.decode(this.bytes(32));
  }

  option<T>(read: (r: this) => T): T | null {
    const tag = this.u8();
    if (tag === 0) return null;
    if (tag !== 1) throw new EncodingError("invalid option tag");
    return read(this);
  }

  end(): void {
    if (this.remaining !== 0) throw new EncodingError(`unexpected ${this.remaining} trailing bytes`);
  }
}
