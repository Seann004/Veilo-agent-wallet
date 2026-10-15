pragma circom 2.2.3;

include "../../src/lib/merkle.circom";

// Test-only harness: exposes MerkleRoot(16) for vector checks.
component main = MerkleRoot(16);
