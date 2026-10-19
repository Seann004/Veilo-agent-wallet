# Dependency license map

Reviewed 17 October 2026 against source snapshot `fe13778` and the exact published dependency archives noted below. Required third-party copyright and license notices remain in the root `NOTICE`.

## Direct reuse and tooling

| Source / pinned version | Use in Veilo | License evidence |
|---|---|---|
| [circomlib 2.0.5](https://github.com/iden3/circomlib/tree/v2.0.5) | Circuit Poseidon, bit decomposition/comparators | Exact [npm archive](https://registry.npmjs.org/circomlib/-/circomlib-2.0.5.tgz) declares `GPL-3.0`; `bitify.circom` / `comparators.circom` carry 0KIMS 2018 GPL v3-or-later headers. Do not substitute the current default branch's LGPL text. |
| [circomlibjs 0.1.7](https://github.com/iden3/circomlibjs/blob/v0.1.7/package.json) | Privacy SDK Poseidon and vectors | Exact npm archive and package declaration: `GPL-3.0`. |
| [snarkjs 0.7.6](https://github.com/iden3/snarkjs/blob/v0.7.6/COPYING) | Proving/setup in circuits and privacy SDK | Exact npm archive includes GPL v3 `COPYING`; package declares `GPL-3.0`. |
| [circom 2.2.3](https://github.com/iden3/circom/blob/v2.2.3/COPYING) | Docker circuit compiler | GPL v3 `COPYING`. |
| [groth16-solana 0.2.0](https://crates.io/crates/groth16-solana/0.2.0) | On-chain BN254 verifier in `programs/veilo-crypto` | Exact [crate archive](https://crates.io/api/v1/crates/groth16-solana/0.2.0/download): Cargo metadata says MIT; bundled `LICENSE` says Apache-2.0. **Unresolved discrepancy**, not established dual licensing. |
| [x402 Foundation SDK](https://github.com/x402-foundation/x402/blob/main/LICENSE), 2.28.0 | `@x402/core`, SVM/HTTP adapters; payment validation and local facilitator | Exact `@x402/core` 2.28.0 npm metadata: Apache-2.0, consistent with upstream license. Preserve notices for each distributed package. |
| Original Veilo research fixture | `services/gateway/fixtures/research/records.json` | CC0-1.0 dedication in that directory's `LICENSE.md`; Harbourview/figures/organizations are fictional. |

Dependencies are consumed through manifests/lockfiles, not relicensed by `NOTICE`. This table targets reused protocol/crypto sources; it is not a complete SBOM or distribution clearance. Frontend, service, Rust, Docker and transitive packages retain their own notices and must be inventoried for an actual release. The owner must resolve the verifier discrepancy and review GPL distribution obligations before selecting a project license or bundling the prover.

## External service dependencies

PayAI Echo and the facilitator, Solana devnet/RPC and OpenRouter are remote services, not code relicensed here. Operators need their own working accounts/quotas, test assets and role keys. The gateway operator pays commercial inference separately; research demo data is not live search. Competition acceptance of devnet transactions and reuse remains an organizer question.
