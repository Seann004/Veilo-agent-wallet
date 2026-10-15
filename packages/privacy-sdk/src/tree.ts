import { assertFieldElement, EncodingError } from "./field";
import type { Poseidon } from "./poseidon";

export const TREE_DEPTH = 16;
export const APPROVED_TREE_DEPTH = 16;

/** Z[0] = 0, Z[i+1] = H2(Z[i], Z[i]). Z[depth] is the empty root. */
export function zeroValues(p: Poseidon, depth = TREE_DEPTH): bigint[] {
  const z = [0n];
  for (let i = 0; i < depth; i++) z.push(p.h2(z[i]!, z[i]!));
  return z;
}

export function pathBits(index: number, depth = TREE_DEPTH): number[] {
  assertIndex(index, depth);
  return Array.from({ length: depth }, (_, i) => (index >>> i) & 1);
}

function assertIndex(index: number, depth: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 2 ** depth) {
    throw new EncodingError(`leaf index must be in [0, 2^${depth})`);
  }
}

/** Recomputes a root from a leaf and its path: bit i set means the running node is the right child. */
export function rootFromPath(p: Poseidon, leaf: bigint, index: number, siblings: readonly bigint[]): bigint {
  const depth = siblings.length;
  const bits = pathBits(index, depth);
  let cur = assertFieldElement(leaf, "leaf");
  for (let i = 0; i < depth; i++) {
    const sib = siblings[i]!;
    cur = bits[i] === 1 ? p.h2(sib, cur) : p.h2(cur, sib);
  }
  return cur;
}

export interface MerklePath {
  index: number;
  leaf: bigint;
  siblings: bigint[];
  pathBits: number[];
  root: bigint;
}

/** Append-only Poseidon Merkle tree; unset slots hold 0. */
export class MerkleTree {
  readonly depth: number;
  readonly zeros: bigint[];
  private readonly layers: bigint[][];

  constructor(
    private readonly p: Poseidon,
    depth = TREE_DEPTH,
  ) {
    this.depth = depth;
    this.zeros = zeroValues(p, depth);
    this.layers = Array.from({ length: depth + 1 }, () => []);
  }

  get size(): number {
    return this.layers[0]!.length;
  }

  get root(): bigint {
    return this.layers[this.depth]![0] ?? this.zeros[this.depth]!;
  }

  private node(level: number, i: number): bigint {
    return this.layers[level]![i] ?? this.zeros[level]!;
  }

  /** Appends at the next index and returns that index. Zero leaves are rejected (0 marks an empty slot). */
  append(leaf: bigint): number {
    assertFieldElement(leaf, "leaf");
    if (leaf === 0n) throw new EncodingError("leaf must be nonzero");
    const index = this.size;
    if (index >= 2 ** this.depth) throw new EncodingError("tree is full");
    this.layers[0]!.push(leaf);
    let i = index;
    for (let level = 0; level < this.depth; level++) {
      const parent = i >> 1;
      const left = this.node(level, parent * 2);
      const right = this.node(level, parent * 2 + 1);
      this.layers[level + 1]![parent] = this.p.h2(left, right);
      i = parent;
    }
    return index;
  }

  leaf(index: number): bigint {
    assertIndex(index, this.depth);
    return this.node(0, index);
  }

  /** Path for any index, including the next empty slot (as the insert circuit needs). */
  path(index: number): MerklePath {
    assertIndex(index, this.depth);
    const siblings: bigint[] = [];
    let i = index;
    for (let level = 0; level < this.depth; level++) {
      siblings.push(this.node(level, i ^ 1));
      i >>= 1;
    }
    return { index, leaf: this.leaf(index), siblings, pathBits: pathBits(index, this.depth), root: this.root };
  }
}
