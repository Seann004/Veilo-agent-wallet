pragma circom 2.2.3;

include "circomlib/circuits/poseidon.circom";
include "../../src/lib/note.circom";

// Test-only harness: exposes H2, H3 and the note derivations as outputs for vector checks.
template Hashes() {
    signal input h2[2];
    signal input h3[3];
    signal input value;
    signal input label;
    signal input nullifierSecret;
    signal input noteSecret;

    signal output h2Out;
    signal output h3Out;
    signal output precommitment;
    signal output commitment;
    signal output nullifierHash;

    component p2 = Poseidon(2);
    p2.inputs <== h2;
    h2Out <== p2.out;

    component p3 = Poseidon(3);
    p3.inputs <== h3;
    h3Out <== p3.out;

    component pre = Poseidon(2);
    pre.inputs[0] <== nullifierSecret;
    pre.inputs[1] <== noteSecret;
    precommitment <== pre.out;

    component note = NoteCommitment();
    note.value <== value;
    note.label <== label;
    note.nullifierSecret <== nullifierSecret;
    note.noteSecret <== noteSecret;
    commitment <== note.commitment;

    component nf = NullifierHash();
    nf.nullifierSecret <== nullifierSecret;
    nf.label <== label;
    nullifierHash <== nf.out;
}

component main = Hashes();
