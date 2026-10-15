import { assertFieldElement, assertU64, EncodingError } from "./field";
import { assertNote, changeNote, commitment, nullifierHash, type Note, type NoteSecrets } from "./note";
import type { Poseidon } from "./poseidon";
import { rootFromPath, TREE_DEPTH, type MerklePath } from "./tree";

/** Groth16 public input order per circuit. The compiled artifacts are tested against these lists. */
export const PUBLIC_INPUTS = {
  spend: ["context", "stateRoot", "approvedRoot", "nullifierHash", "withdrawnValue", "newCommitment"],
  insert: ["oldRoot", "newRoot", "leafIndex", "leaf"],
  exit: ["stateRoot", "label", "value", "nullifierHash"],
} as const;

export type CircuitName = keyof typeof PUBLIC_INPUTS;

export type SignalInputs = Record<string, string | string[]>;

export interface CircuitWitness {
  inputs: SignalInputs;
  /** Expected public signals in Groth16 order. */
  publicSignals: bigint[];
}

const dec = (x: bigint): string => x.toString(10);

type PathLike = Pick<MerklePath, "index" | "siblings">;

function checkPath(path: PathLike, what: string): void {
  if (path.siblings.length !== TREE_DEPTH) throw new EncodingError(`${what} must have ${TREE_DEPTH} siblings`);
  path.siblings.forEach((s) => assertFieldElement(s, `${what} sibling`));
}

export interface SpendParams {
  note: Note;
  statePath: PathLike;
  approvedPath: PathLike;
  context: bigint;
  withdrawnValue: bigint;
  change: NoteSecrets;
}

export interface SpendWitness extends CircuitWitness {
  changeNote: Note;
  nullifierHash: bigint;
  newCommitment: bigint;
}

export function spendWitness(p: Poseidon, params: SpendParams): SpendWitness {
  const { note, statePath, approvedPath, change } = params;
  assertNote(note);
  checkPath(statePath, "state path");
  checkPath(approvedPath, "approved path");
  assertFieldElement(params.context, "context");
  assertU64(params.withdrawnValue, "withdrawn value");
  const next = changeNote(note, params.withdrawnValue, change);
  const stateRoot = rootFromPath(p, commitment(p, note), statePath.index, statePath.siblings);
  const approvedRoot = rootFromPath(p, note.label, approvedPath.index, approvedPath.siblings);
  const nf = nullifierHash(p, note);
  const newCommitment = commitment(p, next);
  return {
    inputs: {
      context: dec(params.context),
      stateRoot: dec(stateRoot),
      approvedRoot: dec(approvedRoot),
      nullifierHash: dec(nf),
      withdrawnValue: dec(params.withdrawnValue),
      newCommitment: dec(newCommitment),
      value: dec(note.value),
      label: dec(note.label),
      nullifierSecret: dec(note.nullifierSecret),
      noteSecret: dec(note.noteSecret),
      stateIndex: dec(BigInt(statePath.index)),
      stateSiblings: statePath.siblings.map(dec),
      approvedIndex: dec(BigInt(approvedPath.index)),
      approvedSiblings: approvedPath.siblings.map(dec),
      newNullifierSecret: dec(change.nullifierSecret),
      newNoteSecret: dec(change.noteSecret),
    },
    publicSignals: [params.context, stateRoot, approvedRoot, nf, params.withdrawnValue, newCommitment],
    changeNote: next,
    nullifierHash: nf,
    newCommitment,
  };
}

export interface InsertParams {
  /** Path of the empty slot at `index` under the current root. */
  path: PathLike;
  leaf: bigint;
}

export function insertWitness(p: Poseidon, { path, leaf }: InsertParams): CircuitWitness {
  checkPath(path, "insert path");
  assertFieldElement(leaf, "leaf");
  if (leaf === 0n) throw new EncodingError("leaf must be nonzero");
  const oldRoot = rootFromPath(p, 0n, path.index, path.siblings);
  const newRoot = rootFromPath(p, leaf, path.index, path.siblings);
  const leafIndex = BigInt(path.index);
  return {
    inputs: {
      oldRoot: dec(oldRoot),
      newRoot: dec(newRoot),
      leafIndex: dec(leafIndex),
      leaf: dec(leaf),
      siblings: path.siblings.map(dec),
    },
    publicSignals: [oldRoot, newRoot, leafIndex, leaf],
  };
}

export interface ExitParams {
  note: Note;
  statePath: PathLike;
}

export function exitWitness(p: Poseidon, { note, statePath }: ExitParams): CircuitWitness {
  assertNote(note);
  checkPath(statePath, "state path");
  const stateRoot = rootFromPath(p, commitment(p, note), statePath.index, statePath.siblings);
  const nf = nullifierHash(p, note);
  return {
    inputs: {
      stateRoot: dec(stateRoot),
      label: dec(note.label),
      value: dec(note.value),
      nullifierHash: dec(nf),
      nullifierSecret: dec(note.nullifierSecret),
      noteSecret: dec(note.noteSecret),
      index: dec(BigInt(statePath.index)),
      siblings: statePath.siblings.map(dec),
    },
    publicSignals: [stateRoot, note.label, note.value, nf],
  };
}
