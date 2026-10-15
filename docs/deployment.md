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
- `cargo build-sbf` writes a fresh program keypair to `target/deploy/privacy_pool-keypair.json` if none exists. That keypair is an unfunded build by-product, is gitignored, and is not the deployment identity. The deployed program ID will be chosen and recorded by `pnpm deploy:devnet`. Until then, `declare_id!` and `Anchor.toml` use the placeholder `8yAoFe83DSyRJzDTzhUvkhAP42XmceSQ4K81RRKGLfjm`, which is the base58 encoding of the fixed ASCII bytes `veilo/privacy-pool/placeholder/0`. Nobody holds a private key for it. Build with `--ignore-keys` until deployment.
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

These commands exist but exit with status 2 and "not implemented yet (Txx)" until their task lands: `test:circuits` (T06), `test:integration` (T15), `deploy:devnet` (T09), `demo:seed` (T10–T13), `demo:run` (T15), `evidence:export` (T16), `backup` and `restore` (T15).

## Program

### Build and test

| Command | What it does |
|---|---|
| `pnpm test:program` | Generates real Groth16 proofs for a fixed test scenario on the host (`scripts/program-fixtures.ts` with the TypeScript SDK and the manifest-pinned zkeys in `circuits/build`; run `pnpm test:circuits` first if that directory is empty), then inside the toolchain image runs `programs/privacy-pool/scripts/test.sh`: both SBF builds, the program's host unit tests and the LiteSVM suite in `programs/privacy-pool/litesvm` |
| `pnpm tc -- sh programs/privacy-pool/scripts/build.sh` | Builds `privacy_pool.so` twice: feature `localnet` (tests) and the default feature `devnet` (deployable; pins the devnet genesis hash) |
| `pnpm tc -- anchor build --ignore-keys` | Standard Anchor build (devnet feature) and IDL |

Build output for the scripts lives on the `veilo-cargo-registry` Docker volume (`veilo-pool-target*`), not on the Windows bind mount, which is much slower. The scripts delete the program keypairs that `cargo build-sbf` writes; the deployment identity is created by `deploy:devnet` (T09). `anchor idl build` must not be used: it rewrites `declare_id!` and `Anchor.toml` to a freshly generated key. The published IDL is `artifacts/program/privacy_pool.json`.

The tests load the program (SBPF v3, as `anchor build` produces with platform-tools v1.57) into LiteSVM 0.17.0 (Agave 4.3 runtime) with the token and ATA programs LiteSVM ships. Under its default feature set LiteSVM runs p-token (the pinocchio SPL Token replacement) at the Tokenkeg address; the original SPL Token program costs a few thousand CU more per transfer (at most two transfers per instruction), which stays far below every limit below. T09 must confirm that devnet accepts SBPF v3 deployments, or rebuild with `--arch v0` (that build was 421,872 bytes, 0.2 SOL more ProgramData rent). Real proofs are verified on-chain by `groth16-solana`; no verifier is mocked.

### Measurements (`artifacts/program/measurements.json`)

Compute units include the 150 CU `SetComputeUnitLimit` instruction. Transaction sizes are full signed legacy transactions with every account (packet limit 1,232 bytes).

| Instruction | CU measured | Client CU limit | Tx bytes |
|---|---|---|---|
| initialize_pool | 52,982 | 200,000 | 741 |
| deposit | 25,586–33,086 | 100,000 | 618 |
| refund_pending_deposit | 18,001 | 100,000 | 512 |
| insert_leaf | 108,919–109,192 | 300,000 | 574 |
| skip_refunded_deposit | 11,327 | 100,000 | 284 |
| update_approved_root | 8,252 | 100,000 | 412 |
| spend_private | 137,800–139,970 | 400,000 | 960 (no relayer) to 1,152 (relayer signing besides the sponsor, fee account) |
| exit_public | 121,255 | 300,000 | 907 |
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

That leaves about 4.5 SOL after deployment for sponsored deposits, spends, exits and ATA creation (about 0.003 SOL per private spend plus fees). Deploy with `--max-len` equal to the binary size unless an upgrade with a larger binary is planned: every extra byte of ProgramData costs about 0.00000696 SOL. If a deployment is interrupted, recover the buffer rent with `solana program close --buffers` before retrying. Nothing here has been deployed or signed; deployment is T09.
