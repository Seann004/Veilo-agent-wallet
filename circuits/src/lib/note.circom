pragma circom 2.2.3;

include "circomlib/circuits/poseidon.circom";

// commitment = H3(value, label, H2(nullifierSecret, noteSecret))
template NoteCommitment() {
    signal input value;
    signal input label;
    signal input nullifierSecret;
    signal input noteSecret;
    signal output commitment;

    component pre = Poseidon(2);
    pre.inputs[0] <== nullifierSecret;
    pre.inputs[1] <== noteSecret;

    component c = Poseidon(3);
    c.inputs[0] <== value;
    c.inputs[1] <== label;
    c.inputs[2] <== pre.out;
    commitment <== c.out;
}

// nullifierHash = H2(nullifierSecret, label); shared by spend and exit.
template NullifierHash() {
    signal input nullifierSecret;
    signal input label;
    signal output out;

    component h = Poseidon(2);
    h.inputs[0] <== nullifierSecret;
    h.inputs[1] <== label;
    out <== h.out;
}
