import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNote,
  buildVectors,
  changeNote,
  deriveLabel,
  EncodingError,
  FIELD_MODULUS,
  fromBe32,
  getPoseidon,
  hexToBytes,
  intentBytes,
  MerkleTree,
  rootFromPath,
  toBe32,
  u64Be,
  U64_MAX,
  zeroValues,
} from "../src/index";

const vectorsPath = resolve(import.meta.dirname, "../../../artifacts/vectors/v1.json");

describe("v1 vectors", () => {
  it("the TypeScript reference reproduces artifacts/vectors/v1.json exactly", async () => {
    const file = readFileSync(vectorsPath, "utf8").replace(/\r\n/g, "\n");
    expect(`${JSON.stringify(await buildVectors(), null, 2)}\n`).toBe(file);
  });

  it("reproduces the known answers stated in docs/protocol.md", async () => {
    const v = await buildVectors();
    expect(v.poseidon[0]!.output).toBe("7853200120776062878684798364095072458815029376092732009249414926327459813530");
    expect(v.label[0]!.sha256).toBe("0f45865e3b3b52830c96b11a2c977348dbfd84cf4d68f4883bc3ee6ec3e8d414");
    expect(v.label[0]!.label).toBe("26982549026179648375948272714466525149453452057491867059920738696902731988");
    expect(v.intent.valid[0]!.context).toBe("383604537787421432873602590773414849761730441832740634255932250059287683319");
    expect(v.intent.valid[1]!.context).toBe("426079571826414574869686923751093208027994267944572661321022180604323884885");
  });
});

describe("field encoding", () => {
  it("round-trips canonical values and rejects aliases", () => {
    for (const x of [0n, 1n, U64_MAX, FIELD_MODULUS - 1n]) expect(fromBe32(toBe32(x))).toBe(x);
    expect(() => toBe32(FIELD_MODULUS)).toThrow(EncodingError);
    expect(() => toBe32(-1n)).toThrow(EncodingError);
    expect(() => fromBe32(hexToBytes(FIELD_MODULUS.toString(16).padStart(64, "0")))).toThrow(EncodingError);
    expect(() => fromBe32(new Uint8Array(31))).toThrow(EncodingError);
    expect(() => fromBe32(new Uint8Array(33))).toThrow(EncodingError);
    expect(() => u64Be(U64_MAX + 1n)).toThrow(EncodingError);
  });

  it("Poseidon rejects inputs >= r instead of reducing them", async () => {
    const p = await getPoseidon();
    expect(() => p.h2(FIELD_MODULUS, 0n)).toThrow(EncodingError);
    expect(() => p.h3(0n, 0n, FIELD_MODULUS + 5n)).toThrow(EncodingError);
  });

  it("label and intent encodings require exactly 32-byte keys", () => {
    const k = new Uint8Array(32);
    expect(() => deriveLabel({ pool: k, mint: k, refundAuthority: new Uint8Array(31), salt: k })).toThrow(EncodingError);
    const ctx = { programId: k, pool: k, genesisHash: k, mint: k };
    const intent = {
      destinationTokenAccount: k,
      destinationOwner: k,
      payoutAmount: 1n,
      relayerFee: 0n,
      relayer: null,
      relayerFeeTokenAccount: null,
      validUntilSlot: 0n,
    };
    expect(intentBytes(ctx, intent)).toHaveLength(296);
    expect(() => intentBytes(ctx, { ...intent, destinationOwner: new Uint8Array(33) })).toThrow(EncodingError);
  });
});

describe("notes and trees", () => {
  const note = { value: 10n, label: 5n, nullifierSecret: 7n, noteSecret: 9n };

  it("rejects malformed notes and change derivations", () => {
    expect(() => assertNote({ ...note, label: 0n })).toThrow(EncodingError);
    expect(() => assertNote({ ...note, noteSecret: note.label })).toThrow(EncodingError);
    expect(() => assertNote({ ...note, value: U64_MAX + 1n })).toThrow(EncodingError);
    expect(() => changeNote(note, 11n, { nullifierSecret: 8n, noteSecret: 3n })).toThrow(EncodingError);
    expect(() => changeNote(note, 1n, { nullifierSecret: 7n, noteSecret: 3n })).toThrow(EncodingError);
    expect(changeNote(note, 10n, { nullifierSecret: 8n, noteSecret: 3n }).value).toBe(0n);
  });

  it("appends leaves and produces paths that recompute the root, including empty slots", async () => {
    const p = await getPoseidon();
    const t = new MerkleTree(p, 16);
    expect(t.root).toBe(zeroValues(p, 16)[16]);
    for (let i = 1n; i <= 5n; i++) t.append(p.h2(i, i));
    for (const i of [0, 3, 4, 5, 65535]) {
      const path = t.path(i);
      expect(rootFromPath(p, path.leaf, i, path.siblings)).toBe(t.root);
    }
    expect(() => t.append(0n)).toThrow(EncodingError);
    expect(() => t.path(65536)).toThrow(EncodingError);
  });
});
