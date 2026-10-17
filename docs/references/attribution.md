# Source provenance and license map

Reviewed 17 October 2026 against source snapshot `fe13778`, PRD Part VI and the exact published dependency archives noted below. Root `NOTICE` retains the complete zx402 MIT notice; it does not license all of Veilo. **Owner decision: select Veilo's own license.** No root `LICENSE` has been added.

## Architecture and adapted invariants

[zx402](https://github.com/Marcussy34/zx402/tree/9da88d099bb1ad28c0de3e2b0b7e15e2a1fd198d), by Marcus Tan, is the architectural reference pinned by PRD sections 18/23 and Part VI. That local corpus includes its MIT license, copyright 2026 Marcus Tan. Its pooled-note/spend/insert/public-exit flow, private change, fresh-payer x402 and privacy/trust explanations inform Veilo's circuits, privacy SDK, wallet/relayer and guides. The adaptation changes Cardano/BLS12 to Solana accounts/BN254 and adds delegated policies, shared credits and durable multi-agent workflows.

The source map is PRD section 23: `circuits/src/{spend,insert,ragequit}.circom`, `packages/crypto`, `packages/sdk/src/{sdk,x402}.ts` and the reference privacy/payment/trust guides. Veilo's counterparts are `circuits/src/{spend,insert,exit}.circom`, `packages/privacy-sdk`, `packages/x402-client`, `services/{wallet,relayer}` and the public guides. This is a reference/adaptation map, not proof of which lines were copied. The companion upstream archive was not present in this worktree; the MIT notice was checked against the embedded corpus. Retain notices if additional reused files are identified.

Privacy Pools is acknowledged as architectural lineage; this checkout does not identify directly vendored Privacy Pools contracts. zx402's Cardano transactions and performance claims must never be presented as Veilo Solana evidence.

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
