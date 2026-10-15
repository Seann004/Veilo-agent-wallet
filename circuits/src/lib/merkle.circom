pragma circom 2.2.3;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";

// Root of a depth-`depth` Poseidon(2) Merkle path. Bit i of `index` (LSB = level 0)
// is 1 when the running node is the right child at level i. Num2Bits(depth) also
// proves index < 2^depth.
template MerkleRoot(depth) {
    signal input leaf;
    signal input index;
    signal input siblings[depth];
    signal output root;

    component bits = Num2Bits(depth);
    bits.in <== index;

    component hashers[depth];
    signal cur[depth + 1];
    signal swap[depth];
    cur[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        // swap = bit ? (sibling - cur) : 0, so (left, right) = bit ? (sibling, cur) : (cur, sibling).
        swap[i] <== bits.out[i] * (siblings[i] - cur[i]);
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== cur[i] + swap[i];
        hashers[i].inputs[1] <== siblings[i] - swap[i];
        cur[i + 1] <== hashers[i].out;
    }

    root <== cur[depth];
}
