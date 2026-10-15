pragma circom 2.2.3;

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "./lib/merkle.circom";
include "./lib/note.circom";

// Owner exit. The label is a public input supplied by the program, so the note must carry
// exactly that label. There is no approved-set input.
// Public inputs in this exact order: stateRoot, label, value, nullifierHash. No outputs.
template Exit(depth) {
    signal input stateRoot;
    signal input label;
    signal input value;
    signal input nullifierHash;

    signal input nullifierSecret;
    signal input noteSecret;
    signal input index;
    signal input siblings[depth];

    component valueBits = Num2Bits(64);
    valueBits.in <== value;

    component labelIsZero = IsZero();
    labelIsZero.in <== label;
    labelIsZero.out === 0;

    component note = NoteCommitment();
    note.value <== value;
    note.label <== label;
    note.nullifierSecret <== nullifierSecret;
    note.noteSecret <== noteSecret;

    component merkle = MerkleRoot(depth);
    merkle.leaf <== note.commitment;
    merkle.index <== index;
    merkle.siblings <== siblings;
    merkle.root === stateRoot;

    component nullifier = NullifierHash();
    nullifier.nullifierSecret <== nullifierSecret;
    nullifier.label <== label;
    nullifier.out === nullifierHash;
}

component main {public [stateRoot, label, value, nullifierHash]} = Exit(16);
