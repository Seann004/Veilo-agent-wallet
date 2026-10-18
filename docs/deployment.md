# Deployment

## Toolchain

### Host requirements

| Tool | Version | Notes |
|---|---|---|
| Node.js | 24 LTS recommended; `>=22.14.0 <25` (`engines` enforced via `engine-strict`) | Verified on 24.22.0 (macOS) and 22.14.0 (Windows 11). The toolchain image stays on 22.22.3, the version Anchor 1.2.1 is tested with. |
| pnpm | 10.34.6 (`packageManager` field) | Provided by Corepack. |
| Docker | Docker Desktop / Engine with a Linux daemon | Verified with 28.4.0. Runs every Rust/Solana/Anchor/circom command. |

By default, Rust, the Solana CLI, Anchor and circom are **not** installed on the host. They live only in the pinned toolchain image. The opt-in native mode below runs them on the host at the same pinned versions.

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
- `cargo build-sbf` writes a fresh program keypair to `target/deploy/privacy_pool-keypair.json` if none exists. That keypair is an unfunded build by-product, is gitignored, and is not the deployment identity. The deployment identity is the `programId` role created once by `pnpm keys:init` (`work/keys/devnet/program-id.json`, public key `27DgErLiY8u5ovRDFrr49GVQkpm5hpSjtvX4UY3vAjFd`). `pnpm program:set-id` writes it into `declare_id!`, `Anchor.toml` and the published IDL: the address and the `initialize_pool` ProgramData PDA seed, which is the program id's bytes. `pnpm program:set-id -- --check` verifies all four.
- Anchor 1.2.1 `anchor build` syncs program ids before it builds, even with `--ignore-keys`. It reads `target/deploy/privacy_pool-keypair.json`, generates that file if it is missing, and rewrites `declare_id!` and `Anchor.toml` to match it. A build without the right keypair in place therefore embeds a throwaway id. This was observed on 2026-10-17. Build like this instead, then delete the copy:

  ```sh
  install -m 600 work/keys/devnet/program-id.json target/deploy/privacy_pool-keypair.json
  pnpm tc -- anchor build --ignore-keys
  rm target/deploy/privacy_pool-keypair.json
  pnpm program:set-id -- --check   # must print "ok": true
  ```

  `pnpm deploy:devnet` also refuses a binary that does not embed the role program id.
- The Anchor workspace is at the repository root (`Anchor.toml`, `Cargo.toml`, `rust-toolchain.toml` pinned to 1.97.1, `Cargo.lock`). The program crate lives in `programs/privacy-pool` with `anchor-lang = "=1.2.1"`.

### Native toolchain (`VEILO_TOOLCHAIN=native`)

Docker is the default. With `VEILO_TOOLCHAIN=native`, three commands run on the host instead, in the same working directory: `pnpm tc`, the circuit build (`circuits/scripts/build.ts`) and the `solana program deploy` step of `pnpm deploy:devnet`.

Before each command, `scripts/toolchain-native.mjs` reads the pins from `docker/toolchain.Dockerfile`. It checks `rustc`, `solana`, `anchor` and `circom` on `PATH`, and checks that the pinned platform-tools exist in `~/.cache/solana/<PLATFORM_TOOLS_VERSION>`. A missing tool or another version stops the command before it runs. Any `VEILO_TOOLCHAIN` value other than `docker` or `native` is an error.

The shell scripts read two variables:

- `VEILO_WORKSPACE`: the repository root. It is `/workspace` in Docker and the checkout natively.
- `VEILO_CACHE_DIR`: the build cache. It is the cargo-registry volume in Docker and `target/native-cache/` natively.

Installing the pins on macOS (arm64), done on 2026-10-17:

```sh
agave-install init 4.1.2                        # or the release.anza.xyz/v4.1.2 installer
cargo-build-sbf --install-only --tools-version v1.57
avm install 1.2.1 && avm use 1.2.1
cargo install --locked --git https://github.com/iden3/circom --tag v2.2.3 circom
# rustc 1.97.1 comes from rust-toolchain.toml through rustup.
```

`agave-install init` switches `~/.local/share/solana/install/active_release`, a symlink that every shell of the user shares. If other work on the machine uses another Solana version, put `~/.local/share/solana/install/releases/4.1.2/solana-release/bin` first on `PATH` instead.

Versions on the Mac that ran the 2026-10-17 redeployment:

```
rustc 1.97.1 (8bab26f4f 2026-07-14)
solana-cli 4.1.2 (src:182084b8; feat:c763ae0a, client:Agave)
cargo-build-sbf 4.1.0 (default platform-tools v1.54; v1.57 installed)
anchor-cli 1.2.1
circom compiler 2.2.3 (iden3/circom tag v2.2.3, commit ad44e915)
snarkjs 0.7.6 (workspace dependency)
node v22.23.3, pnpm 10.34.6
```

The host Node is 22.23.3, not the image's 22.22.3. Both satisfy `engines`. `programs/privacy-pool/scripts/build.sh` calls `cargo build-sbf` without `--tools-version`, so it uses the cargo-build-sbf default (v1.54 for 4.1.0) both natively and in the image.

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

Compute units include the 150 CU `SetComputeUnitLimit` instruction. Values were regenerated after each program id change (T09; last for 27Dg…AjFd on 2026-10-17): PDA bump searches differ per program id, roughly 1.5k CU per extra iteration. Transaction sizes are full signed legacy transactions with every account (packet limit 1,232 bytes).

| Instruction | CU measured | Client CU limit | Tx bytes |
|---|---|---|---|
| initialize_pool | 46,982 | 200,000 | 741 |
| deposit | 27,086–33,086 | 100,000 | 618 |
| refund_pending_deposit | 18,001 | 100,000 | 512 |
| insert_leaf | 108,919–109,192 | 300,000 | 574 |
| skip_refunded_deposit | 11,327 | 100,000 | 284 |
| update_approved_root | 8,252 | 100,000 | 412 |
| spend_private | 136,310–142,300 | 400,000 | 960 (no relayer) to 1,152 (relayer signing besides the sponsor, fee account) |
| exit_public | 119,755 | 300,000 | 907 |
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

### Roles (`pnpm keys:init`, run 2026-10-17 on macOS)

Keypairs live in `work/keys/devnet/` (gitignored, owner-only ACL) on the Mac that deployed the pool, and nowhere else. Back them up before relying on this deployment; the previous deployment was retired because its keys stayed on another machine (`artifacts/deployment/prior-3B6D/README.md`). `artifacts/deployment/roles.devnet.json` records only public keys and the pool id. A rerun keeps existing files and stops if a recorded role file is missing or holds a different key.

| Role | Public key | Purpose |
|---|---|---|
| deployer | `FcAoTX7M7GnQHgQRVN81bAfd7khph1ZpC8gz37c9AAhy` | Upgrade authority, deploy fee payer, `initialize_pool` signer |
| programId | `27DgErLiY8u5ovRDFrr49GVQkpm5hpSjtvX4UY3vAjFd` | Program address (in `declare_id!`, `Anchor.toml` and the IDL) |
| programBuffer | `4YW7MrdbT3zgi57pL4oAY8YJYsqjFHpfMDK1PKvsxApu` | Deploy buffer, reused so an interrupted deploy resumes |
| sponsor | `D7iWAmNqEJvJ3GaoiGX4rzdEnmpcMrykMDmZvvw6uamd` | Relayer and fee/rent sponsor (manifest sponsor = relayer) |
| merchant | `3hbVsik3DMzaXaCCBrtua2xJt4M152hCsZ17bkLHueFT` | Gateway `payTo` owner; merchant ATA `45oAG4yFR88nFQQVN6iGKtfKPD55vaNtXoxzGhrwaatz` |
| approvalAuthority | `7gpa8LcVEm3MLX4JqPtfbv95heRFKpsFCA4R84EhdDRE` | `update_approved_root` only |
| configAuthority | `5797zmtBdH4rWVAryxjtTreNpiQajkMYX6GqmkTSPmbe` | `update_config` only; not funded (no transaction planned) |
| testOwnerA | `7oTzRWg33mod7KxVUiVWBUyMna6wgrQXUv3dC58ZsabE` | Synthetic test participant A |
| testOwnerB | `mYG89rxGotGF2VYoT3tffbMbsaKdCaJEoAPbTXzWEZ2` | Synthetic test participant B |

Pool id `39cced46df181bdbf4813f07e9ad553c4f7c02a4ab14730cead9ca2b6e100c3e`. Derived addresses: PoolState `5u3NV47tnYYQ2uaT6WSo9XkmJLnCAY54fG7fHiDasuhe`, VaultAuthority `AwEDp4gTWkXZzGhefaQ3rZhYuTAaSrEKBzci4RqZN33y`, vault `5MwxHt19yYSqcACa3UpABdQNsQhBN3v6jHLNSeKjBrGu`, ApprovalState `93626hbqJEjEY376ZH2goAgP8pWifvDECxSrhF5BqTkw`, ProgramData `ErofgrMt7PU56rkkk4kiazRvSnw2VjR1g1wecYgFNcr4`.

Binary: `target/deploy/privacy_pool.so` from `pnpm tc -- anchor build --ignore-keys` with `VEILO_TOOLCHAIN=native` on macOS arm64 (SBPF v3, devnet feature, platform-tools v1.57). It is 378,080 bytes, sha256 `864410cdc896bf5387b595450ce45d9568d3b2978be9729fc5630fcd92b862f9`. The deploy script refuses a binary that does not embed the role program id. Deploy with `--max-len` equal to the binary size.

### Budget (devnet rent read live on 2026-10-17, dry run)

| Item | SOL |
|---|---|
| ProgramData rent (45 + 378,080 B), locked | 1.921525 |
| Program account rent, locked | 0.000833 |
| Deploy buffer rent (returned to the deployer when the deploy completes) | 1.921485 (temporary) |
| Deploy fees (~379 write transactions, ×2 retry margin) | 0.003850 |
| `initialize_pool` rent (PoolState + ApprovalState + vault) | 0.010551 |
| Merchant ATA rent | 0.001488 |
| Peak held by the deployer during deploy | 3.847693 |
| Locked after deployment | 1.934398 |
| Transfers from the funding wallet: deployer 3.879753 (peak + init + ATA + 0.02 margin), sponsor 0.30, approval authority 0.01, testOwnerA 0.03, testOwnerB 0.03 | **4.249753** |
| Funding wallet after the transfers (from 5.726240) | 1.476478 |
| Test-USDC step: 0.2 test USDC per participant (0.4 total) plus two ATA creations | 0.002987 SOL |

The previous deployment's figures (2026-10-15, 378,808-byte binary, 4.257159 SOL transferred) are in `artifacts/deployment/prior-3B6D/`.

Spending during the M2 smoke:

- About 0.02 SOL in total. The participants pay deposit and exit rent and fees. The sponsor pays the fresh-payer ATA, spend rent, and the insert and spend fees.
- 10,000 test-USDC base units go to the Echo merchant (Echo refunds them to the fresh payer).

The figures are recomputed on every dry run, and a shortfall stops the run.

### Operator commands, in order

Run each command from the repository root (in a Claude Code session: `! <command>`). Docker must be running, unless you set `VEILO_TOOLCHAIN=native`. `.env` already holds `FUNDING_KEY_PATH=work/keys/veilo-devnet-funding.json`.

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
- **`solana program deploy` fails mid-way** (devnet RPC drops writes): rerun step 2. The CLI resumes from buffer `4YW7Mr…xApu`. To abandon instead and reclaim the buffer rent: `pnpm tc -- solana program close 4YW7MrdbT3zgi57pL4oAY8YJYsqjFHpfMDK1PKvsxApu --url https://api.devnet.solana.com --keypair work/keys/devnet/deployer.json`.
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

**OpenRouter budget guard.** The worst case is maximum input plus maximum output tokens per call, at the pinned `deepseek/deepseek-v4-flash` tariff (dry run, 2026-10-17):

| Call | Worst case (micro-USD) |
|---|---|
| Prince planning (sponsored, ≤ 2) | ≤ 1,020 |
| analyze (prepaid credits) | ≤ 1,092 |
| per-call analyze fallback (runs only if prepaid is refused) | ≤ 1,092 |
| Mira planning (sponsored, ≤ 2) | ≤ 1,020 |
| content-package (direct x402) | ≤ 1,274 |
| **Total** | **≤ 5,498 (≈ $0.0055)** |

Before executing, `demo:run` adds the exposure already recorded by live calls in the known gateway ledgers. It refuses if the total exceeds `OPERATOR_MAX_REAL_USD_MICRO`, and sets the demo gateway's own ceiling to the remainder. If real inference is disabled, the run reports `BLOCKED real-demo gate` and stops before signing.

### Operator commands, in order

1. Readiness and plan (read-only; no signing and no OpenRouter call):
   `pnpm demo:run`
   Expected lines:
   - `chain: devnet genesis EtWT…ZBG`
   - `pool: verified — program 27Dg…AjFd, PoolState 5u3N…suhe`
   - `gateway merchant 3hbV…HueFT: ATA 45oA…aatz exists`
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

### Devnet runs on the retired 3B6D pool

On 2026-10-17 between 01:15:41 and 01:18:07 UTC, a full demo:run-shaped execution was signed from the Windows machine against program `3B6D…rUrq`. Its state file, evidence and note stores stayed on that machine. That pool is retired; see `artifacts/deployment/prior-3B6D/README.md`.

### Runs on 27Dg…AjFd from macOS (2026-10-17)

Three runs were executed. The first two stopped at step d. The third passed every acceptance check.

**Run `2026-10-17-e60755f3`: stopped at step d (merchant signing).** Steps a and b finalized: deposits `3eoEDQb2…kUHm`, `5pYgMF9y…zU73N` and `3BRRHBKr…3MRPr`, approval `37DWQqSK…sebK`, and the credit pack (withdrawal `upe58KYT…YM3`, x402 `gjE8z7yh…Rv9i`). In step c, Prince bought `research-expanded` (withdrawal `5S2tz7rk…zkhg`, x402 `5ipsYM7J…kA1i`), but the task ended `incomplete`.

- In all three purchases, the wallet's first `POST /fundings/:id/merchant-payment` failed with `unhandled SolanaError` (HTTP 500).
- The failing read is the x402 SDK's own mint read on a plain, non-retrying RPC; the gateway challenge carries the blockhash.
- The wallet logged only the error class, so the exact code was not recorded. A probe of `api.devnet.solana.com` afterwards rejected 111 of 150 burst mint reads with HTTP 429, which is the likely cause.
- Control read the 500 as `recovery_required`. Prince's runner stopped using the purchase, although the sweep later completed it.

Fixed in the wallet, x402-client, control and runner (build-status T12). Now:

- An RPC, rate-limit, timeout or network failure before the fresh wallet signs is `not_ready`, and it is logged with its Solana error code.
- Control re-drives the same purchase with backoff on the same funding.
- Any failure after signing stays `recovery_required` and is never re-signed.
- The mint read goes through `createDevnetRpc`.
- The runner waits with `purchase_status` instead of giving up.

**Run `2026-10-17-96c82bb7`: stopped at step d (empty inference).** Steps a and b finalized:

- deposits `3ZQ7ybDp…RybfNS`, `5G6586Di…eJmk8Q2` and `62SQJL2Z…kxGtPiQ`
- approval `61hcBjCa…p4F`
- credit pack: withdrawal `2kEVdePA…uD2R`, x402 `r7iNURv2…sb6f`

Prince's dataset purchase (withdrawal `5HXKy9Pa…ebGQ`, x402 `4Vn1Srwk…k58j`) signed on the first call. The prepaid `analyze` call then got HTTP 200 from OpenRouter with `finish_reason: "length"` and `content: null`: DeepSeek V4 Flash spent its 2,000-token bound on reasoning (2,317 reasoning tokens in a replay). The gateway correctly refused the empty completion, and the task ended `incomplete`.

The pinned model now declares `reasoning: "disabled"`, so the request carries `reasoning: { enabled: false }`. A replay then returned 3,758 characters, and a live `content-package` replay validated.

**Run `2026-10-17-1eba868c`: complete, all 11 acceptance checks pass.**

- a: deposits `2pKB6Vyw…mKN9`, `2bxAGTar…Y5w9` and `7z6eqkCt…pcAi`, then `update_approved_root` `4jUWFQRo…kPf8` and `9Nf5Qs2m…RX1H`. The first attempt stopped before signing with relayer `NOT_READY`, and the rerun resumed.
- b: credit pack withdrawal `3oEFBWny…Z75Fb`, x402 `3Tb73hwk…hRAnJ`.
- c: research-expanded withdrawal `AVjERYY4…ptoa`, x402 `3o2JtHux…Jz1`. Real DeepSeek `analyze` used prepaid credits. Prince's task completed and requested the handoff.
- d: content-package withdrawal `oefXfDPG…Sj4E`, x402 `pg6uMdTg…ALQH`. Mira's task completed with three drafts and a seven-day calendar.
- e: duplicate checks created no new purchase.
- f: both concurrent over-budget requests were refused with `BUDGET_EXCEEDED`. After Prince was revoked, his tool call got HTTP 401.
- g: the owner exited 0.5 test USDC (`2JSGW9Xg…T7Y`).

Every merchant signing call in runs `96c82bb7` and `1eba868c` succeeded on the first attempt (five of five). Evidence: `artifacts/evidence/demo-2026-10-17-1eba868c/` (its secret scan was clean over 39 known secret values) and `artifacts/evidence-export/2026-10-17T08-28-08-894Z/`.

Operator-funded inference, provider-reported: 88 micro-USD (run e607), 73 micro-USD (run 96c8) and 205 micro-USD (run 1eba). Two diagnostic replays cost about 430 more.

The stopped runs' notes stay in the pool: 1.8 test USDC each for `e60755f3` and `96c82bb7`. Their state files are `work/demo/devnet-state.2026-10-17-<runId>.json`, and their note stores are under `work/demo/devnet/<runId>/`. The owner can exit them from this Mac.

### Running on macOS (operator checklist)

Prerequisites on the Mac:

1. Node 22: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`. The default Node 25 is outside `engines`.
2. The role keys of `27Dg…AjFd` exist only on the Mac that deployed it, under `work/keys/devnet/`. On another machine, copy that directory and `work/keys/veilo-devnet-funding.json` to the same relative paths. Do not create new keys for these roles. Then restrict the files: `chmod 700 work work/keys work/keys/devnet && chmod 600 work/keys/*.json work/keys/devnet/*.json`.
3. `circuits/build/` can be rebuilt with `pnpm test:circuits`. The setup is deterministic, and the build fails if any hash differs from `artifacts/circuits/manifest.json`.
4. `pnpm deploy:devnet` fills `.env` (`POOL_PROGRAM_ID`, `POOL_ID`, `SPONSOR_KEY_PATH`, `APPROVED_PARTICIPANTS`, `GATEWAY_MERCHANT_ADDRESS`, `GATEWAY_MERCHANT_ATA`). It never overwrites a different existing value, so clear the old values before deploying a new pool. Also set:
   - `FUNDING_KEY_PATH=work/keys/veilo-devnet-funding.json`
   - `OPENROUTER_API_KEY`: a key with its own provider-side spend limit
   - `OPERATOR_MAX_REAL_USD_MICRO`: at least 5,498, for example `50000`. The budget guard counts only gateway ledgers on this machine.
5. Ports 4700–4705 must be free during the run.

Commands, in order:

```sh
pnpm install --frozen-lockfile
pnpm check:devnet
pnpm demo:run                          # read-only; must end with "readiness: all checks passed"
pnpm demo:run -- --execute --confirm   # signs; about 3–20 minutes
pnpm evidence:export
```

If `--execute` stops, rerun the same command. Then commit `artifacts/evidence/demo-<runId>/` and the export, after checking that both secret scans were clean.

Balances after run `1eba868c` (finalized, 2026-10-17):

| Account | Has | Needs per run |
|---|---|---|
| funding/demo owner 3FCi…kMFd | 1.4479 SOL, 8.48 test USDC | readiness: 0.05 SOL and 3.0 test USDC; spends ≈ 0.0091 SOL |
| sponsor D7iW…uamd | 0.2702 SOL | readiness: 0.03 SOL; spends ≈ 0.0112 SOL (measured ≈ 0.0062–0.0124 per run) |
| approval authority 7gpa…hdDRE | 0.009975 SOL | readiness: 0.0001 SOL; spends 0.000005–0.000015 SOL |
| merchant 3hbV…HueFT | 0 SOL; ATA holds 3.9 test USDC paid by the three runs | 0 (the facilitator pays fees) |
| pool vault 5Mwx…BrGu | 4.6 test USDC, all owner notes from the three runs | — |
| deployer FcAo…AAhy | 1.9435 SOL (deploy buffer refund) | not used by demo:run |

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

## Dashboard on Vercel

Only the dashboard (`apps/dashboard`) runs on Vercel. Control, wallet, relayer, gateway, runner
and marketplace keep SQLite files, sealed keys and a local Chrome, so they run on a host with a
persistent disk (a VM or container) and are reached over HTTPS.

1. Import the repository in Vercel and set **Root Directory** to `apps/dashboard`. Vercel detects
   Next.js and the pnpm workspace; `apps/dashboard/vercel.json` pins the install and build commands,
   and the `engines` range selects Node 24.
2. Set these environment variables on the Vercel project:

   | Variable | Value |
   | --- | --- |
   | `VEILO_DASHBOARD_ORIGIN` | The dashboard's public origin, e.g. `https://veilo.vercel.app` |
   | `VEILO_CONTROL_URL` | HTTPS URL of the control service |
   | `VEILO_WALLET_URL` | HTTPS URL of the wallet service |
   | `VEILO_RELAYER_URL` | HTTPS URL of the relayer service |
   | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_MARKETPLACE_URL` | Marketplace settings, as in `.env` |

   The `VEILO_*_URL` values must be `https://` (plain `http://` is accepted only for localhost) and
   carry no credentials or query string; the dashboard refuses to start otherwise. Without them it
   uses the loopback ports, as in local development.
3. On the services host, set the same `VEILO_DASHBOARD_ORIGIN`, so control accepts the dashboard's
   requests and builds links to it. Keep the services bound to loopback behind a TLS reverse proxy
   (or a tunnel) that exposes only control, wallet and relayer.

The browser still talks only to the dashboard: its `/api/<service>/…` routes forward the session
cookie and CSRF header to the configured upstreams, as they do locally. Session cookies become
`Secure` automatically when the dashboard origin is HTTPS.

