pragma circom 2.2.3;

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "./lib/merkle.circom";
include "./lib/note.circom";

// Public inputs, declared first and in this exact order: context, stateRoot, approvedRoot,
// nullifierHash, withdrawnValue, newCommitment. The template has no outputs, so the Groth16
// public input vector equals this order.
template Spend(depth) {
    signal input context;
    signal input stateRoot;
    signal input approvedRoot;
    signal input nullifierHash;
    signal input withdrawnValue;
    signal input newCommitment;

    signal input value;
    signal input label;
    signal input nullifierSecret;
    signal input noteSecret;
    signal input stateIndex;
    signal input stateSiblings[depth];
    signal input approvedIndex;
    signal input approvedSiblings[depth];
    signal input newNullifierSecret;
    signal input newNoteSecret;

    // value, withdrawnValue and remainder are all < 2^64, so value - withdrawnValue cannot wrap.
    component valueBits = Num2Bits(64);
    valueBits.in <== value;
    component withdrawnBits = Num2Bits(64);
    withdrawnBits.in <== withdrawnValue;
    signal remainder;
    remainder <== value - withdrawnValue;
    component remainderBits = Num2Bits(64);
    remainderBits.in <== remainder;

    component note = NoteCommitment();
    note.value <== value;
    note.label <== label;
    note.nullifierSecret <== nullifierSecret;
    note.noteSecret <== noteSecret;

    component stateMerkle = MerkleRoot(depth);
    stateMerkle.leaf <== note.commitment;
    stateMerkle.index <== stateIndex;
    stateMerkle.siblings <== stateSiblings;
    stateMerkle.root === stateRoot;

    component labelIsZero = IsZero();
    labelIsZero.in <== label;
    labelIsZero.out === 0;

    component approvedMerkle = MerkleRoot(depth);
    approvedMerkle.leaf <== label;
    approvedMerkle.index <== approvedIndex;
    approvedMerkle.siblings <== approvedSiblings;
    approvedMerkle.root === approvedRoot;

    component nullifier = NullifierHash();
    nullifier.nullifierSecret <== nullifierSecret;
    nullifier.label <== label;
    nullifier.out === nullifierHash;

    component sameSecret = IsZero();
    sameSecret.in <== newNullifierSecret - nullifierSecret;
    sameSecret.out === 0;

    // The change note keeps the parent label.
    component change = NoteCommitment();
    change.value <== remainder;
    change.label <== label;
    change.nullifierSecret <== newNullifierSecret;
    change.noteSecret <== newNoteSecret;
    change.commitment === newCommitment;

    signal contextSquare;
    contextSquare <== context * context;
}

component main {public [context, stateRoot, approvedRoot, nullifierHash, withdrawnValue, newCommitment]} = Spend(16);
