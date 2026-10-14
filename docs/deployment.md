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
