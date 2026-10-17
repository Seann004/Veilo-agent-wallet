import { assertFieldElement, assertU64, EncodingError } from "./field";
import type { Poseidon } from "./poseidon";

export interface NoteSecrets {
  nullifierSecret: bigint;
  noteSecret: bigint;
}

export interface Note extends NoteSecrets {
  value: bigint;
  label: bigint;
}

function assertSecret(x: bigint, what: string): void {
  assertFieldElement(x, what);
  if (x === 0n) throw new EncodingError(`${what} must be nonzero`);
}

export function assertNote(note: Note): void {
  assertU64(note.value, "note value");
  assertFieldElement(note.label, "label");
  if (note.label === 0n) throw new EncodingError("label must be nonzero");
  assertSecret(note.nullifierSecret, "nullifier secret");
  assertSecret(note.noteSecret, "note secret");
  // Otherwise precommitment == nullifier hash and the public deposit links to its spend.
  if (note.noteSecret === note.label) throw new EncodingError("note secret must differ from label");
}

export function precommitment(p: Poseidon, s: NoteSecrets): bigint {
  return p.h2(s.nullifierSecret, s.noteSecret);
}

export function commitment(p: Poseidon, note: Note): bigint {
  assertU64(note.value, "note value");
  return p.h3(note.value, note.label, precommitment(p, note));
}

/** Leaf for a deposit, as the program computes it from the received amount and precommitment. */
export function depositCommitment(p: Poseidon, amount: bigint, label: bigint, pre: bigint): bigint {
  return p.h3(assertU64(amount, "amount"), label, pre);
}

export function nullifierHash(p: Poseidon, note: Pick<Note, "nullifierSecret" | "label">): bigint {
  return p.h2(note.nullifierSecret, note.label);
}

/** Change note after withdrawing `withdrawn`; keeps the label, takes fresh secrets. */
export function changeNote(parent: Note, withdrawn: bigint, fresh: NoteSecrets): Note {
  assertU64(withdrawn, "withdrawn value");
  if (withdrawn > parent.value) throw new EncodingError("withdrawn value exceeds note value");
  if (fresh.nullifierSecret === parent.nullifierSecret) {
    throw new EncodingError("change nullifier secret must differ from the parent's");
  }
  const change: Note = { value: parent.value - withdrawn, label: parent.label, ...fresh };
  assertNote(change);
  return change;
}
