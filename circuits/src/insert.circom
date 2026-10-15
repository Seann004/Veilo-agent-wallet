pragma circom 2.2.3;

include "circomlib/circuits/comparators.circom";
include "./lib/merkle.circom";

// Appends one nonzero leaf at an empty slot.
// Public inputs in this exact order: oldRoot, newRoot, leafIndex, leaf. No outputs.
template Insert(depth) {
    signal input oldRoot;
    signal input newRoot;
    signal input leafIndex;
    signal input leaf;

    signal input siblings[depth];

    component leafIsZero = IsZero();
    leafIsZero.in <== leaf;
    leafIsZero.out === 0;

    // The same siblings open the slot as empty under oldRoot and as `leaf` under newRoot.
    component before = MerkleRoot(depth);
    before.leaf <== 0;
    before.index <== leafIndex;
    before.siblings <== siblings;
    before.root === oldRoot;

    component after = MerkleRoot(depth);
    after.leaf <== leaf;
    after.index <== leafIndex;
    after.siblings <== siblings;
    after.root === newRoot;
}

component main {public [oldRoot, newRoot, leafIndex, leaf]} = Insert(16);
