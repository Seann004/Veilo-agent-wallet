# Deployment

## Toolchain

### Host requirements

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22.x, >= 22.14.0 (`engines` enforced via `engine-strict`) | Verified on 22.14.0 (Windows 11). |
| pnpm | 10.34.6 (`packageManager` field) | Provided by Corepack. |
| Docker | Docker Desktop / Engine with a Linux daemon | Verified with 28.4.0. Runs every Rust/Solana/Anchor/circom command. |

Rust, the Solana CLI, Anchor and circom are **not** installed on the host. They live only in the pinned toolchain image.

#### Enabling pnpm without admin rights (Windows)

`corepack enable` tries to write shims into `C:\Program Files\nodejs` and fails without elevation. Install the shims into the user-writable npm directory, which is already on `PATH`:

```
corepack enable --install-directory "%APPDATA%\npm" pnpm
```

Corepack then runs the pnpm version pinned in `package.json`. pnpm 12.x cannot be launched by the Corepack 0.31.0 bundled with Node 22.14 (missing `bin/pnpm.cjs`), which is why the repository pins the maintained 10.x line. If Corepack is unavailable, `npx pnpm@10.34.6 <command>` is equivalent.

### Toolchain image

`docker/toolchain.Dockerfile` builds `veilo-toolchain:0.1.0`:

| Component | Pinned version | Source |
|---|---|---|
| Base image | `ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55` | Docker Hub |
| Rust (host toolchain for CLIs) | 1.97.1, profile minimal + rustfmt/clippy | rustup |
| Agave / Solana CLI | v4.1.2 | `release.anza.xyz/v4.1.2/install` |
| SBF platform-tools | v1.57 (prefetched; `anchor build` default, SBPF v3) | `cargo-build-sbf --install-only` |
| Anchor CLI | 1.2.1 | `cargo install --locked anchor-cli --version 1.2.1` |
| circom | v2.2.3 | `cargo install --locked --git https://github.com/iden3/circom --tag v2.2.3` |
| Node.js | v22.22.3, tarball SHA-256 verified | nodejs.org |
| pnpm | 10.34.6 | npm |
| snarkjs | 0.7.6 | npm (global, also a workspace dependency) |

Compatibility basis: Anchor 1.2.1 (released 2026-10-05) is tested upstream against Solana CLI 4.1.2 and Node 22.22.3 (its CI and verifiable-build Makefile pin these), and its Rust project templates are exercised with Rust 1.97.1. Agave v4.1.2 was chosen over the newer v4.3.x line because it is the version Anchor 1.2.1 is tested with.

Build the image (about 10 minutes the first time; cached afterwards):

```
pnpm toolchain:build
```

Verified tool versions inside the image:

```
rustc 1.97.1 (8bab26f4f 2026-07-14)
solana-cli 4.1.2 (src:182084b8; feat:c763ae0a, client:Agave)
anchor-cli 1.2.1
circom compiler 2.2.3
snarkjs@0.7.6
v22.22.3
10.34.6
```

### Running tools: `pnpm tc`

`scripts/toolchain.mjs` runs one command in the image with the repository mounted at `/workspace`. The working directory maps from the caller's position inside the repository. Exit codes propagate.

```
pnpm tc -- anchor build --ignore-keys
pnpm tc -- circom --version
pnpm tc -- sh -c "cd circuits && snarkjs --help"
```

Cargo registry and git caches persist in the named Docker volumes `veilo-cargo-registry` and `veilo-cargo-git`. Set `VEILO_TOOLCHAIN_IMAGE` to use another tag.

Notes:

- Build output goes to the gitignored `target/` directory in the repository. Builds over the Windows bind mount are slower than native: the first skeleton build took about 3.5 minutes.
- `cargo build-sbf` writes a fresh program keypair to `target/deploy/privacy_pool-keypair.json` if none exists. That keypair is an unfunded build by-product, is gitignored, and is not the deployment identity. The deployment identity is the `programId` role created once by `pnpm keys:init` (`work/keys/devnet/program-id.json`, public key `3B6Db74gPstdciTfr1gdYG4DuhA2DpTGqYM9jgthYUrq`). `pnpm program:set-id` writes it into `declare_id!`, `Anchor.toml` and the published IDL (`pnpm program:set-id -- --check` verifies all three). Always build with `--ignore-keys` and delete the by-product keypair.
- The Anchor workspace is at the repository root (`Anchor.toml`, `Cargo.toml`, `rust-toolchain.toml` pinned to 1.97.1, `Cargo.lock`). The program crate lives in `programs/privacy-pool` with `anchor-lang = "=1.2.1"`.

### Local setup and checks

```
pnpm install            # pnpm built-in; installs from pnpm-lock.yaml
pnpm setup:local        # validates Node/pnpm/Docker/image and config, creates data/ and secrets/ (owner-only)
pnpm check:devnet       # read-only: RPC genesis hash + mint owner/decimals at finalized commitment
pnpm check              # typecheck + eslint across the workspace
pnpm test               # vitest across all workspace projects
pnpm dev                # dashboard :3000, control :4101, runner :4102, wallet :4103, gateway :4104, relayer :4105
```

`setup:local` never creates or replaces keys, never moves funds and never calls paid services. Pass `--skip-toolchain` to skip the Docker checks when you only work on TypeScript services.

`pnpm test:integration`, `pnpm demo:run` and `pnpm evidence:export` are described in "Integration suite", "Demo run" and "Evidence export" below.

## Program

### Build and test

| Command | What it does |
|---|---|
| `pnpm test:program` | Generates real Groth16 proofs for a fixed test scenario on the host (`scripts/program-fixtures.ts` with the TypeScript SDK and the manifest-pinned zkeys in `circuits/build`; run `pnpm test:circuits` first if that directory is empty), then inside the toolchain image runs `programs/privacy-pool/scripts/test.sh`: both SBF builds, the program's host unit tests and the LiteSVM suite in `programs/privacy-pool/litesvm` |
| `pnpm tc -- sh programs/privacy-pool/scripts/build.sh` | Builds `privacy_pool.so` twice: feature `localnet` (tests) and the default feature `devnet` (deployable; pins the devnet genesis hash) |
| `pnpm tc -- anchor build --ignore-keys` | Standard Anchor build (devnet feature) and IDL |

Build output for the scripts lives on the `veilo-cargo-registry` Docker volume (`veilo-pool-target*`), not on the Windows bind mount, which is much slower. The scripts delete the program keypairs that `cargo build-sbf` writes; the deployment identity is created by `deploy:devnet` (T09). `anchor idl build` must not be used: it rewrites `declare_id!` and `Anchor.toml` to a freshly generated key. The published IDL is `artifacts/program/privacy_pool.json`.

The tests load the program (SBPF v3, as `anchor build` produces with platform-tools v1.57) into LiteSVM 0.17.0 (Agave 4.3 runtime) with the token and ATA programs LiteSVM ships. Under its default feature set LiteSVM runs p-token (the pinocchio SPL Token replacement) at the Tokenkeg address; the original SPL Token program costs a few thousand CU more per transfer (at most two transfers per instruction), which stays far below every limit below. Devnet accepts SBPF v3: feature `5cC3foj77CWun58pC51ebHFUWavHWKarWyR5UUik7dnC` (SIMD-0178/0189/0377, SBPFv3 deployment and execution) is active since epoch 1069 (`pnpm tc -- solana feature status -u https://api.devnet.solana.com --display-all`, read 2026-10-15). No `--arch v0` build is needed. Real proofs are verified on-chain by `groth16-solana`; no verifier is mocked.

### Measurements (`artifacts/program/measurements.json`)

Compute units include the 150 CU `SetComputeUnitLimit` instruction. Values were regenerated after the program id change (T09): PDA bump searches differ per program id, roughly 1.5k CU per extra iteration. Transaction sizes are full signed legacy transactions with every account (packet limit 1,232 bytes).

| Instruction | CU measured | Client CU limit | Tx bytes |
|---|---|---|---|
| initialize_pool | 45,482 | 200,000 | 741 |
| deposit | 25,586–30,086 | 100,000 | 618 |
| refund_pending_deposit | 18,001 | 100,000 | 512 |
| insert_leaf | 108,919–109,192 | 300,000 | 574 |
| skip_refunded_deposit | 11,327 | 100,000 | 284 |
| update_approved_root | 8,252 | 100,000 | 412 |
| spend_private | 137,800–142,970 | 400,000 | 960 (no relayer) to 1,152 (relayer signing besides the sponsor, fee account) |
| exit_public | 118,255 | 300,000 | 907 |
| update_config | 8,138 | 100,000 | 360 |

Address lookup table: **not required**. The largest transaction (spend with a separate relayer signer and a fee account) is 1,152 bytes, 80 bytes under the limit. A v0 transaction with a table holding `pool_state, approval_state, vault, vault_authority, token_program, system_program` brings it to 1,002 bytes and is tested; use it if a client adds instructions (for example a priority-fee instruction plus an ATA creation) to the spend transaction. The program id cannot go in the table because it is invoked.

Accounts and rent (rent-exempt minimum at the default rent, never closed in v1):

| Account | Bytes | Lamports | Created by |
|---|---|---|---|
| PoolState | 1,407 | 10,683,600 | initialize_pool |
| ApprovalState | 121 | 1,733,040 | initialize_pool |
| TokenVault (SPL token account) | 165 | 2,039,280 | initialize_pool |
| PendingDeposit | 234 | 2,519,520 | each deposit |
| SeenPrecommitment | 49 | 1,231,920 | each deposit |
| PendingChange | 130 | 1,795,680 | each spend |
| SpentNullifier | 50 | 1,238,880 | each spend and exit |

Per operation: deposit 0.00375 SOL, spend 0.00303 SOL, exit 0.00124 SOL, all paid by the transaction payer (depositor or sponsor).

### Devnet deployment cost plan (funded wallet: 10 SOL)

Devnet build `privacy_pool.so`: 391,456 bytes from `programs/privacy-pool/scripts/build.sh` (`cargo build-sbf --arch v3`); `anchor build --ignore-keys` produced 378,808 bytes. The figures below use the larger build.

| Item | SOL |
|---|---|
| ProgramData account (45 + 391,456 bytes), locked | 2.7257 |
| Program account (36 bytes), locked | 0.0011 |
| Deploy buffer (37 + 391,456 bytes), refunded when the deploy completes | 2.7257 (temporary) |
| Buffer write and deploy fees, estimate (about 387 write transactions) | ≈ 0.0039 |
| initialize_pool rent (PoolState + ApprovalState + vault) | 0.0145 |
| **Peak needed during deployment** | **≈ 5.47** |
| **Locked after deployment** | **≈ 2.74** |

That leaves about 4.5 SOL after deployment for sponsored deposits, spends, exits and ATA creation (about 0.003 SOL per private spend plus fees). Deploy with `--max-len` equal to the binary size unless an upgrade with a larger binary is planned: every extra byte of ProgramData costs about 0.00000696 SOL. If a deployment is interrupted, recover the buffer rent with `solana program close --buffers` before retrying. The live devnet figures are recomputed by `pnpm deploy:devnet` from `getMinimumBalanceForRentExemption`. On 2026-10-15 devnet returned lower rent than the default the table above assumes; see the runbook below.

## Devnet deployment runbook (T09 / M2)

Every signing step is run by the operator. The scripts are dry runs by default: they make read-only RPC calls and print the plan. They sign only with both `--execute` and `--confirm`. Each transaction signature is persisted before the transaction is sent. A rerun reconciles from finalized chain state instead of signing again. A mismatch stops the run, and no key, pool or manifest is ever replaced. A run lock refuses a second concurrent run.

### Roles (`pnpm keys:init`, already run)

Keypairs live in `work/keys/devnet/` (gitignored, owner-only ACL). `artifacts/deployment/roles.devnet.json` records only public keys and the pool id. A rerun keeps existing files and stops if a recorded role file is missing or holds a different key.

| Role | Public key | Purpose |
|---|---|---|
| deployer | `38jQg7zthCCZ6thwHDkWfeLHXV8Xg5uwERHP3dhgBTNR` | Upgrade authority, deploy fee payer, `initialize_pool` signer |
| programId | `3B6Db74gPstdciTfr1gdYG4DuhA2DpTGqYM9jgthYUrq` | Program address (in `declare_id!`, `Anchor.toml` and the IDL) |
| programBuffer | `7Fy4yfFiBMFFcZqMffStY8Fx9bu3Jq7nshfnAGRrCQqR` | Deploy buffer, reused so an interrupted deploy resumes |
| sponsor | `8djHL1qrsvv6mJJVbfw6i8A1nqeGDw4SQor7YW8tKtcD` | Relayer and fee/rent sponsor (manifest sponsor = relayer) |
| merchant | `49TED53TmAC4EsScoN3zn6iTHZXAcz6J5w9trmnyAVWX` | Gateway `payTo` owner; merchant ATA `9YVRYnbzEojUGCNVuW1eGjjzPywAYYWRV92omacRjMuC` |
| approvalAuthority | `AiZqKdteFDA3sTiimS9Ga4gGk1BG6R8yWcr646mMgvMd` | `update_approved_root` only |
| configAuthority | `HYFB3197KpG11xoSrdBfBmWwGWMWbdQAVMa8cQxysvea` | `update_config` only; not funded (no transaction planned) |
| testOwnerA | `53EfGeKqr3VFvhfr3DFVrK3LaK6KUPoPu6TCAr6qARks` | Synthetic test participant A |
| testOwnerB | `69ardTTzQcZWhTPcHzKodr6TFThxGUehajd2diFthaXv` | Synthetic test participant B |

Pool id `c012ae927dfd556e75e9d2f1893a1ffcb1834eee6f1df4f4c5ff7fc3d9b2d589`. Derived addresses: PoolState `65FNWNc1akaXFsPFCoLGMwjnefGbpts3sw4KEVYQ8Tab`, VaultAuthority `J2CxmbQrLhhWhLKFUZMpgXpSGfDBsbpTamYjC7yry1jG`, vault `GQ7u2E8t1mEkUwo4NanbPFy5NhzGJHdhD8FY32ZWorgt`, ApprovalState `9im1P2PRuozYWQpFF6FBViqyDLFSdUBjJ7kr4e7tKTUF`, ProgramData `DWeeQQKCKewGPi4hUyfQ5tdz3aFb3Hp1rrWasYWFQkN9`.

Binary: `target/deploy/privacy_pool.so` from `pnpm tc -- anchor build --ignore-keys` (SBPF v3, devnet feature). It is 378,808 bytes, sha256 `01449e43d097ea1a09049f0397d62aad8d4777250ceef780eb62a70c8044e278`. The deploy script refuses a binary that does not embed the role program id. Deploy with `--max-len` equal to the binary size.

### Budget (devnet rent read live on 2026-10-15, dry run)

| Item | SOL |
|---|---|
| ProgramData rent (45 + 378,808 B), locked | 1.925223 |
| Program account rent, locked | 0.000833 |
| Deploy buffer rent (returned to the deployer when the deploy completes) | 1.925183 (temporary) |
| Deploy fees (~379 write transactions, ×2 retry margin) | 0.003850 |
| `initialize_pool` rent (PoolState + ApprovalState + vault) | 0.010551 |
| Merchant ATA rent | 0.001488 |
| Peak held by the deployer during deploy | 3.855089 |
| Locked after deployment | 1.938096 |
| Transfers from the funding wallet: deployer 3.887149 (peak + init + ATA + 0.02 margin), sponsor 0.30, approval authority 0.01, testOwnerA 0.03, testOwnerB 0.03 | **4.257159** |
| Funding wallet after the transfers (from 10.0) | ≈ 5.74 |
| Test-USDC step: 0.2 test USDC per participant (0.4 total) plus two ATA creations | 0.002987 SOL |

Spending during the M2 smoke:

- About 0.02 SOL in total. The participants pay deposit and exit rent and fees. The sponsor pays the fresh-payer ATA, spend rent, and the insert and spend fees.
- 10,000 test-USDC base units go to the Echo merchant (Echo refunds them to the fresh payer).

The figures are recomputed on every dry run, and a shortfall stops the run.

### Operator commands, in order

Run each command from the repository root (in a Claude Code session: `! <command>`). Docker must be running. `.env` already holds `FUNDING_KEY_PATH=work/keys/veilo-devnet-funding.json`.

1. Plan (read-only):
   `pnpm deploy:devnet`
   Expected output:
   - the role and address tables above
   - `Facilitator ... supported`
   - `On chain: program not deployed; pool not initialized; merchant ATA missing`
   - the SOL plan, then `DRY RUN complete`
2. Deploy (signs; about 5 to 15 minutes, mostly the ~379 buffer writes):
   `pnpm deploy:devnet -- --funding work/keys/veilo-devnet-funding.json --execute --confirm`
   Expected lines, in order:
   - `fund-roles: finalized`
   - `deploy-program: verified; signature ...`
   - `initialize-pool: finalized`
   - `merchant-ata: finalized`
   - `approval-root: on-chain approved root version 0 = published list`
   - `manifest: wrote artifacts/deployment/devnet.json (relayer verifyDeployment: verified)`
   - `.env: set POOL_PROGRAM_ID, POOL_ID, SPONSOR_KEY_PATH, APPROVED_PARTICIPANTS, GATEWAY_MERCHANT_ADDRESS, GATEWAY_MERCHANT_ATA`
   - `Deployment complete`
3. Fund the two synthetic participants with test USDC (signs one transaction):
   `pnpm deploy:devnet -- --fund-test-usdc --funding work/keys/veilo-devnet-funding.json --execute --confirm`
   Expected: `fund-test-usdc: finalized`.
4. Smoke plan (read-only):
   `pnpm demo:private-smoke`
   Expected: `deployment: verified`, `public state: consistent true; leaves 0`, no `WARNING`, and the 7-step plan.
5. M2 private smoke (signs; about 5 to 10 minutes):
   `pnpm demo:private-smoke -- --execute --confirm`
   Expected: `[1/7]` through `[7/7]` with finalized signatures, then `M2 smoke complete`.

When step 5 has finished, reply "done". The scripts have already written the deployment files (`artifacts/deployment/devnet.json`, `devnet.progress.json`, `approved-labels.json`). They have also written the evidence files `artifacts/evidence/m2-{deploy,deposits,inserts,approve-root,spend,change-insert,merchant,exits,summary}.json`. The evidence holds signatures, explorer links, devnet compute units per instruction, rent, sponsor lamports and proof latency.

### What the smoke does

- **Steps 1–3:** two 0.2 test-USDC deposits, one each from testOwnerA and testOwnerB. The sponsor's insert crank inserts both, with real insert proofs. The approval authority then publishes the approved labels under the prototype rule.
- **Step 4:** the wallet's `FundingService` builds a real spend proof from A's note. The payout is 10,000 to a fresh payer. The in-process relayer (`WithdrawalService`) checks the proof off-chain, creates the fresh payer's ATA and submits `spend_private`.
- **PRIV-07 check:** the spend transaction must not contain any deposit's owner, owner ATA, PendingDeposit/SeenPrecommitment PDA, commitment, label, precommitment or salt.
- **Step 5:** inserts the change note.
- **Step 6:** the fresh payer pays PayAI's Echo merchant 10,000 base units with an ordinary x402 v2 exact payment. The facilitator is the fee payer.
- **Step 7:** B publicly exits the original note, and A publicly exits the change note.

The control service is not part of this gate. The operator's `--execute --confirm` stands in for control's prepare, release and sign stages, and the evidence records this. Notes live in an encrypted smoke wallet under `work/devnet-smoke/` (gitignored, separate owner secret). The relayer database for the smoke is `work/devnet-smoke/relayer.sqlite`, so its sponsor ledger is separate from the service's `data/relayer.sqlite`.

### If something stops

- **Any stop:** fix the cause and rerun the **same** command. Sent transactions are reconciled by signature, and a transaction whose blockhash expired unseen is rebuilt. Nothing is signed twice for one step. If the smoke's state file and the wallet database disagree about the in-flight purchase, the wallet's funding is adopted, never re-proved.
- **`solana program deploy` fails mid-way** (devnet RPC drops writes): rerun step 2. The CLI resumes from buffer `7Fy4yf…CQqR`. To abandon instead and reclaim the buffer rent: `pnpm tc -- solana program close 7Fy4yfFiBMFFcZqMffStY8Fx9bu3Jq7nshfnAGRrCQqR --url https://api.devnet.solana.com --keypair work/keys/devnet/deployer.json`.
- **`... not finalized yet; rerun later`:** devnet is slow; wait a minute and rerun.
- **Mismatch stops:** this covers a deployed binary that differs, PoolState fields that differ, a manifest that differs, or `approved-labels.json` belonging to another pool. Nothing is overwritten. Investigate before continuing; upgrades are deliberately not automated.
- **Facilitator or Echo unavailable:** the merchant step stops before signing, because the challenge is fetched and verified first. A rerun continues at that step.
- **Spend stops before the relayer recorded the withdrawal** (for example an RPC 429): rerun the same command. While the proof is within its slot bound, the wallet resends the identical request. The relayer now records a request before any chain read, so a failed read leaves it recorded and retried.
- **Spend attempt expired unsettled:** the finalized slot passed the proof's bound and the nullifier is unused. The run stops with `attempt N ... expired unsettled ... rerun the same command`. A rerun starts attempt N+1 of the same logical operation with a new proof, slot bound, change secrets and fresh payer. The expired attempt's record is kept, and its proof is never resent. `m2-spend.json` lists every attempt. The program's nullifier account still allows at most one spend of the note.
- **`--stop-after <step>`** (`deposits`, `inserts`, `approve-root`, `release`, `spend`, `change-insert`, `merchant`) ends a run after that step. State is kept, so a rerun continues from there.
- **Echo replies but settlement never finalizes:** the step stops with `merchant payment expired_unsettled` once the payment blockhash expires. The fresh payer then holds the payout, which owner recovery can return (not part of this gate).
- **RPC without full transaction history:** the indexer replays the pool from `getSignaturesForAddress`. If the RPC prunes history, the replay disagrees with the chain and the run stops with `IndexerError ... replay disagrees with chain`. Use `https://api.devnet.solana.com` or another full-history devnet RPC.

### Local rehearsal (no devnet)

Setting `VEILO_DEPLOY_PROFILE=local-rehearsal` and `VEILO_ENV_FILE=work/rehearsal/.env` runs the same scripts against a loopback `solana-test-validator` in the toolchain container.

- It uses throwaway keys and a locally crafted 6-decimal mint account at the pinned mint address.
- It keeps every file under `work/rehearsal/`.
- It refuses non-loopback, devnet and mainnet RPC endpoints.
- It skips the Echo payment.

The container needs three settings:

- `--security-opt seccomp=unconfined`, because Agave requires io_uring
- `--bind-address $(hostname -i)`
- a large `--limit-ledger-size`, because the indexer needs full history

On 2026-10-15/16 the rehearsal ran the whole flow end to end with the real SPL Token program:

- deploy, plus an idempotent rerun
- test-USDC funding
- two deposits and three inserts
- approve-root
- a real-proof spend through the relayer, with PRIV-07 passing
- change insertion and both exits

It also resumed correctly after a killed run. Measured on that validator:

| Instruction | CU (including the 150 CU compute-budget instruction) |
|---|---|
| deposit | 25,897–30,397 |
| insert_leaf | 108,343–108,614 |
| update_approved_root | 7,922 |
| spend_private | 138,103 |
| exit_public (with idempotent ATA creation) | 121,534–126,034 |

Proof latency on this host: spend ≈1.0 s, exit ≈0.55 s, insert 0.8–2.8 s (the first proof per process includes setup).

## Integration suite (`pnpm test:integration`)

`pnpm test:integration` runs `tests/integration/suite.test.ts` against a local stack that `scripts/local-stack/` builds from nothing:

- **Chain:** a loopback `solana-test-validator` in the toolchain container (`veilo-integration-validator`, RPC `127.0.0.1:5630`). The deployed program binary (`target/deploy/privacy_pool.so`, the devnet build) is preloaded at the devnet program id, and a 6-decimal mint is preloaded at the pinned mint address with a throwaway mint authority. The pool is initialized with `initialize_pool`, and the manifest comes from the same builder `deploy:devnet` uses (`scripts/devnet/manifest.ts`). Every key is a throwaway key under `work/integration/keys/`.
- **Services:** control, runner, wallet, relayer and gateway run as separate OS processes (`services/*/src/index.ts`) with `VEILO_CHAIN_PROFILE=local-test-validator`. That profile accepts only loopback RPC and facilitator URLs and refuses devnet and mainnet genesis, so it cannot act on a public cluster.
- **Merchant leg:** the Veilo gateway with a self-hosted facilitator (`scripts/local-stack/facilitator.ts`). It is the official `@x402/core` `x402Facilitator` with the `@x402/svm` exact scheme, signing as fee payer with a local key and settling on the local validator. It is not PayAI or Kora.
- **Provider:** a loopback OpenRouter-compatible mock (`scripts/local-stack/mock-provider.ts`), labeled FIXTURE; it never counts as real inference.
- **Proofs:** real Groth16 proofs (snarkjs, manifest-pinned zkeys), verified on chain by the program. Nothing in the private path is mocked.
- **Fault injection:** every inter-service link runs through a loopback proxy (`scripts/local-stack/proxy.ts`): control→wallet, control→gateway, wallet→control, wallet→relayer, runner→control, gateway→facilitator, and the relayer/wallet/gateway RPC links. A rule can:
  - drop a request before delivery
  - drop the reply after the callee committed
  - hold a request
  - kill every service process at that boundary

  A restart is a hard kill and a fresh process over the same databases. Under the local profile only, the gateway also honours `VEILO_TEST_CRASH_POINTS` (`gateway.afterClaim`, `gateway.afterPaymentFinalized`, `gateway.beforeProviderCall`).

Requirements: Docker running, `target/deploy/privacy_pool.so` built and `circuits/build` present (`pnpm test:circuits`). The command writes `artifacts/evidence/integration-<date>.json` with:

- counts, environment and PRD IDs
- failed and skipped tests
- per-scenario evidence

That file is labeled local-validator evidence: it contains no devnet transaction and no real inference. Optional variables:

- `VEILO_IT_KEEP=1` keeps the validator container afterwards
- `VEILO_IT_REUSE=1` reuses `work/integration/` and the running validator
- `VEILO_IT_BASE_PORT` (default 5600) moves every port

Extra arguments go to vitest, for example `--bail=1`.

## Demo run (`pnpm demo:run`)

`pnpm demo:run` drives the PRD §16 script through the real backend services: control, runner, wallet, relayer and gateway as processes. No dashboard events are faked.

- **Demo owner:** the funding wallet (`FUNDING_KEY_PATH`). It signs the owner session challenge, the deposits and the exit.
- **Isolation:** each run gets its own control, gateway, relayer and wallet databases and service credentials under `work/demo/devnet/<runId>/`.
- **Provider key:** the OpenRouter key goes to the gateway process in memory only and is never written to a file.
- **Resume:** run state lives in `work/demo/devnet-state.json`. A rerun after a 429, a timeout or any stop continues from the last completed step: deposits and the exit are reconciled by their recorded signatures, and purchases and tasks by their stable idempotency and trigger keys. Nothing is signed twice for one step.

### Plan and costs

Amounts follow the seeded SKU catalog. Each private purchase spends one note.

| Step | What happens | Test USDC | Notes |
|---|---|---|---|
| a | 3 owner deposits of 1.0 test USDC; relayer insert crank; approval authority approves the owner's labels (prototype rule) | 3.0 into the pool | owner pays deposit rent ≈ 0.0038 SOL each |
| b | Shawn: gateway credits start at 0 (< 200,000). "Check now" runs the scheduled check: private pool → fresh wallet → x402 to the Veilo gateway (merchant `GATEWAY_MERCHANT_ADDRESS`, PayAI devnet facilitator) → one 1,000,000-credit issuance | 1.0 | |
| c | Prince research task (runner): compares research-basic and research-expanded, buys one via private x402, consumes `analyze` with prepaid credits (real bounded OpenRouter inference), saves a cited brief (demo fixture data), requests a handoff | 0.2 (or 0.1) | ≤ 2 sponsored planning calls |
| d | Owner approves the handoff; Mira buys `content-package` directly via private x402 with real inference → three drafts and a seven-day calendar | 0.3 | ≤ 2 sponsored planning calls |
| e | Duplicate check: the same research purchase request and another Shawn check | 0 | must create no purchase |
| f | Mira's allowance is lowered below one package and two concurrent package requests are both rejected; Prince is revoked and a later tool call is refused | 0 | |
| g | Owner public exit of the largest spendable change note back to the funding wallet, with the privacy warning | returns 0.5–0.9 | owner pays exit rent ≈ 0.0013 SOL |

Totals:

- **Test USDC:** merchant spend at most 1.5. Of the 3.0 deposited, the exit returns 0.5–0.9 (the largest change note); the rest stays in the pool as notes.
- **SOL, measured on devnet (2026-10-17 run):** about 0.0203 in total.
  - The owner pays 0.0091386: three deposits at 0.00274312 each and the exit at 0.00090924.
  - The sponsor pays 0.0111700: three fresh-payer ATAs at 0.00149344, three spends at 0.00221988 and six inserts at 0.000005.
  - The approval authority pays 0.000005 per `update_approved_root` (two in that run).
  - The facilitator pays the merchant-leg fees, so the merchant and the fresh payers need no SOL.
- **Worst case test USDC:** if prepaid `analyze` is refused, the per-call fallback adds 0.2, for a merchant spend of 1.7. The three 1.0 notes cover that.

**OpenRouter budget guard.** The worst case is maximum input plus maximum output tokens per call, at the pinned `mistralai/mistral-nemo` tariff:

| Call | Worst case (micro-USD) |
|---|---|
| Prince planning | 2 × 140 |
| analyze | 292 |
| per-call analyze fallback (runs only if prepaid is refused) | 292 |
| Mira planning | 2 × 140 |
| content-package | 322 |
| **Total** | **≤ 1,466 (≈ $0.0015)** |

Before executing, `demo:run` adds the exposure already recorded by live calls in the known gateway ledgers. It refuses if the total exceeds `OPERATOR_MAX_REAL_USD_MICRO`, and sets the demo gateway's own ceiling to the remainder. If real inference is disabled, the run reports `BLOCKED real-demo gate` and stops before signing.

### Operator commands, in order

1. Readiness and plan (read-only; no signing and no OpenRouter call):
   `pnpm demo:run`
   Expected lines:
   - `chain: devnet genesis EtWT…ZBG`
   - `pool: verified — program 3B6D…rUrq, PoolState 65FN…8Tab`
   - `gateway merchant 49TE…AVWX: ATA 9YVR…MuC exists`
   - `facilitator https://facilitator.payai.network: exact/devnet supported, fee payer 2wKu…DBg4`
   - balances for the demo owner, the sponsor and the approval authority
   - the allowance checks, the OpenRouter budget table and the plan
   - `readiness: all checks passed`, then `DRY RUN complete`
2. Run (signs with the funding wallet, the approval authority and the sponsor; about 10–20 minutes):
   `pnpm demo:run -- --execute --confirm`
   Expected lines, in order:
   - `[0-policies]`
   - `[a-deposits]`: three `deposit … finalized` lines and an `update_approved_root` signature
   - `[b-shawn-topup]`: `credit pack delivered`, then credits usable 1000000
   - `[c-prince-research]`: `task completed`
   - `[d-handoff-mira]`: `Mira task completed`
   - `[e-duplicate-check]`: `new purchases 0`
   - `[f-over-budget-and-revoke]`
   - `[g-owner-exit]`: `PRIVACY WARNING …`, then `exit … finalized`
   - `evidence: artifacts/evidence/demo-<runId>`
   - `acceptance:`, then one `ok` line per check (see below)
   - `Demo run <runId> complete`
3. If it stops, rerun the same command; it resumes from the recorded state. To start a new run instead, move `work/demo/devnet-state.json` aside.
4. `pnpm evidence:export` bundles the result (see below).

After the steps, the run evaluates acceptance checks and records them in `summary.json` under `acceptance`:

- Prince's and Mira's tasks ended `completed`.
- The credit pack, one research dataset and the content package were each delivered exactly once via private x402, with a funding (pool withdrawal) signature.
- Each of those merchant-leg transactions is finalized and credited the gateway merchant ATA (derived from the manifest's `gateway.merchantAddress` and the pinned mint) with at least the price.
- `analyze` and `content-package` inference each succeeded at least once in the expected provider mode: `live` on devnet, `fixture` in the local rehearsal.
- A devnet run made no fixture provider call.

If any check fails, the evidence is still written, but the command exits 1 with `acceptance checks failed` instead of `complete`. A rerun resumes the finished run and only re-evaluates the checks.

The evidence directory, `artifacts/evidence/demo-<runId>/`, contains:

- `summary.json`: acceptance checks, steps, deposit, approval and exit signatures with explorer links, and labels that separate operator-funded inference, demo fixture data and test-chain payments
- `ledger.json`: the redacted owner ledger (purchases with both legs' signatures, balances, tasks)
- `inference-receipts.json`: source, SKU, model, mode, tokens and worst-case and actual cost per provider call; no prompts or inputs
- `artifacts/`: the brief, the three drafts and the calendar
- `run-state.json`

The directory is scanned for every known secret value: the provider key, every role and funding keypair, and the run's credentials. It is also scanned for secret-shaped patterns. Any hit fails the run.

### Earlier devnet execution (2026-10-17)

Public devnet history shows one full demo:run-shaped execution on 2026-10-17 between 01:15:41 and 01:18:07 UTC, signed from the Windows machine:

- three deposits by the funding wallet
- two approvals
- three private withdrawals
- three x402 payments to the gateway merchant ATA, of 1,000,000, 200,000 and 300,000
- an 800,000 exit

Its state file, evidence directory and gateway ledger are not in the repository. Before running again, copy `work/demo/` and `artifacts/evidence/demo-*/` from that machine. If the copied run passes `pnpm demo:run -- --execute --confirm`, which only re-checks a finished run, a second run is not needed. The dry run reports such earlier owner deposits when no state file is present.

### Running on macOS (operator checklist)

Prerequisites on the Mac:

1. Node 22: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`. The default Node 25 is outside `engines`.
2. From the Windows checkout, copy these files to the same relative paths. Do not create new keys for these roles.
   - `work/keys/veilo-devnet-funding.json`: the demo owner 3FCio7smQJX7fm5x4Rz2UPPesfHA46FkexC3S3SqkMFd
   - `work/keys/devnet/sponsor-relayer.json`: 8djH…tcD
   - `work/keys/devnet/approval-authority.json`: AiZq…Mgvd
   - optional, so the evidence scan covers every role key: the rest of `work/keys/devnet/`
   - `circuits/build/`: proving files, hash-checked against `artifacts/circuits/manifest.json`
   - optional: `work/demo/` and `artifacts/evidence/demo-*/` from the earlier run, and `artifacts/deployment/approved-labels.json` (the committed copy predates that run; the approval step rebuilds it from chain history if it is stale)

   Then restrict the files: `chmod 700 work work/keys work/keys/devnet && chmod 600 work/keys/*.json work/keys/devnet/*.json`.
3. In `.env`, set:
   - `POOL_PROGRAM_ID=3B6Db74gPstdciTfr1gdYG4DuhA2DpTGqYM9jgthYUrq`
   - `POOL_ID=c012ae927dfd556e75e9d2f1893a1ffcb1834eee6f1df4f4c5ff7fc3d9b2d589`
   - `SPONSOR_KEY_PATH=work/keys/devnet/sponsor-relayer.json`
   - `FUNDING_KEY_PATH=work/keys/veilo-devnet-funding.json`
   - `GATEWAY_MERCHANT_ADDRESS=49TED53TmAC4EsScoN3zn6iTHZXAcz6J5w9trmnyAVWX`
   - `GATEWAY_MERCHANT_ATA=9YVRYnbzEojUGCNVuW1eGjjzPywAYYWRV92omacRjMuC`
   - `OPENROUTER_API_KEY`: a key with its own provider-side spend limit
   - `OPERATOR_MAX_REAL_USD_MICRO`: at least 1466, for example `5000`. The budget guard counts only gateway ledgers on this machine.
4. Ports 4700–4705 must be free during the run.

Commands, in order:

```sh
pnpm install --frozen-lockfile
pnpm check:devnet
pnpm demo:run                          # read-only; must end with "readiness: all checks passed"
pnpm demo:run -- --execute --confirm   # signs; about 3–20 minutes
pnpm evidence:export
```

If `--execute` stops, rerun the same command. Then commit `artifacts/evidence/demo-<runId>/` and the export, after checking that both secret scans were clean.

Funding is sufficient for another run as of 2026-10-17:

| Account | Has | Needs per run | Missing |
|---|---|---|---|
| funding/demo owner 3FCi…kMFd | 5.73 SOL, 17.4 test USDC | readiness: 0.05 SOL and 3.0 test USDC; spends 0.0091 SOL and 3.0 test USDC (0.8 returns by exit) | none |
| sponsor 8djH…tcD | 0.2851 SOL | readiness: 0.03 SOL; spends 0.0112 SOL | none |
| approval authority AiZq…Mgvd | 0.009985 SOL | readiness: 0.0001 SOL; spends 0.000005–0.000015 SOL | none |
| merchant 49TE…AVWX | 0 SOL, ATA exists | 0 (the facilitator pays fees) | none |
| deployer, config authority, testOwnerA/B | n/a | not used by demo:run | none |

### Local rehearsal

`pnpm demo:run -- --local-rehearsal` runs the same steps against a fresh local stack (`work/demo-rehearsal/`, ports 5800 and up) with throwaway keys, the self-hosted facilitator and the FIXTURE provider. It reports the real-demo gate as blocked by design and writes its evidence to `work/demo-rehearsal/evidence/`.

## Evidence export (`pnpm evidence:export`)

`pnpm evidence:export [-- --out <dir>]` writes `artifacts/evidence-export/<timestamp>/` with:

- the deployment manifest, the role public keys and the approved-label list
- sha256 hashes of the program binary, IDL, circuit manifest, verification keys, vectors and manifest
- the program, pool and token addresses
- every transaction signature found in `artifacts/evidence/*.json` and the latest `demo-*` run, with explorer links
- the integration outcome summaries
- the latest demo run's redacted ledger

Before the bundle is accepted, it is scanned for:

- the provider key
- every keypair under `work/keys`, `work/integration/keys` and `work/demo-rehearsal/keys`
- every credential and secret file
- secret-shaped patterns: provider keys, PEM private keys, 64-byte key arrays and bearer tokens

Any hit fails with exit code 1.
