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

These commands exist but exit with status 2 and "not implemented yet (Txx)" until their task lands: `test:integration` (T15), `demo:run` (T15), `evidence:export` (T16).

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
