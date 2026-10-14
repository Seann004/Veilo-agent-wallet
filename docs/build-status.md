# Build status

States: not-started · in-progress · blocked · done. A task is done only when its completion gate passed with recorded evidence.

| Task | State | Dependencies | Commands / checks | Evidence / blockers |
|---|---|---|---|---|
| T00 Repository and contribution policy | done | — | `git config user.name` → Ng Sean Sean; CLAUDE.md extracted verbatim from PRD Part II | Branch `feat/veilo-foundation`; `.gitignore` excludes keys, `work/`, env, databases, ptau/zkey |
| T01 Toolchain and monorepo | done | T00 | corepack pnpm 10.34.6: `pnpm install --frozen-lockfile` (clean) ✓; `pnpm check` ✓; `pnpm test` → 11 files / 36 tests ✓; `pnpm setup:local` ✓; `pnpm check:devnet` vs api.devnet.solana.com ✓ (genesis EtWT…ZBG, mint owner Tokenkeg…, 6 decimals); mainnet RPC / mainnet genesis / wrong mint → exit 1 (WRONG_NETWORK/WRONG_MINT); `pnpm dev` → all six `/health` 200; `pnpm dev` with mainnet RPC → stack stops, exit 1; `pnpm toolchain:build` ✓; `pnpm tc -- anchor build --ignore-keys` ✓ (privacy_pool.so 49,856 B, sha256 e1923e71…599e; IDL generated) | Versions: Node ≥22.14 <23 (image 22.22.3), pnpm 10.34.6, TypeScript 5.9.3, Next.js 16.4.0, React 19.3.0, Express 5.3.0, vitest 5.0.4, vite 8.3.4, zod 4.6.7, better-sqlite3 12.11.1, @x402/core|express|svm|fetch 2.28.0, @solana/kit 5.5.1, snarkjs 0.7.6, circomlibjs 0.1.7, eslint 10.12.0, typescript-eslint 8.71.2, tsx 4.23.15, concurrently 10.0.6. Image veilo-toolchain:0.1.0: Rust 1.97.1, Agave 4.1.2, platform-tools v1.57, Anchor 1.2.1, circom 2.2.3. NET-01 unit tests in packages/contracts. Deviations: see "T01 deviations" below; toolchain in docs/deployment.md, variables in docs/configuration.md |
| T02 Schemas and durable ledger | not-started | T01 | | |
| T03 Owner session and worker boundaries | not-started | T01–T02 | | |
| T04 Ordinary devnet x402 | not-started | T01–T03 | | |
| T05 Protocol specification and vectors | in-progress | T01 | docs/protocol.md written | Spec frozen as v1 draft; cross-language vectors not yet generated (with T06) |
| T06 Circuits and verifier | not-started | T05 | | |
| T07 Pool program and local adversarial tests | not-started | T02, T05–T06 | | |
| T08 Private SDK/indexer/relayer | not-started | T03, T05–T07 | | |
| T09 Devnet private integration | blocked | T04, T07–T08 | | Funded keypair for 3FCio7smQJX7fm5x4Rz2UPPesfHA46FkexC3S3SqkMFd not present on this machine; operator must supply its path via local config |
| T10 Gateway credits and inference | not-started | T02–T04 | | Live inference needs operator OPENROUTER_API_KEY and OPERATOR_MAX_REAL_USD_MICRO |
| T11 Shawn scheduler | not-started | T02–T03, T09–T10 | | |
| T12 Prince research | not-started | T03, T09–T10 | | |
| T13 Mira content | not-started | T03, T09–T10, T12 | | |
| T14 Dashboard and owner recovery | not-started | T03, T08, T10–T13 | | |
| T15 Integrated fault injection and restoration | not-started | T09–T14 | | |
| T16 Handoff and submission materials | not-started | T15 | | |

## Environment notes

- Host: Windows 11, Node 22.14.0, npm 11.4.0, Python 3.13. Rust/Solana/Anchor/circom are not installed on the host; they run inside a pinned Docker toolchain image (see T01).
- Funded setup wallet key is not in this checkout. Scripts take explicit key paths and never print key material.

## T01 deviations

- **pnpm 10.34.6 instead of 12.x.** Corepack 0.31.0 (bundled with Node 22.14) cannot launch pnpm 12.11.2. Corepack shims were installed into `%APPDATA%\npm` because `corepack enable` needs admin rights for `C:\Program Files\nodejs`.
- **TypeScript 5.9.3 instead of 6.x/7.x.** The pinned `@solana/kit` 5.5.1 declares a `typescript@^5` peer, and typescript-eslint 8.71.2 supports `<6.1`.
- **better-sqlite3 12.11.1 instead of 13.x.** The 13.x releases ship no prebuilt binaries, and this host lacks a Windows SDK for node-gyp. 12.11.1 has a Node 22 win32-x64 prebuild. `node:sqlite` was not used because it is still experimental on Node 22.
- **zod 4.6.7 in `@veilo/contracts`.** `@x402/core` 2.28.0 depends on zod ^3 internally. Each copy is isolated by pnpm, and no zod schemas are passed between the two.
- **Host Node 22.14.0, image Node 22.22.3.** The image follows the Node version Anchor 1.2.1 tests with. Both satisfy `engines` (>=22.14.0 <23).
- **The `pnpm install` command is pnpm's built-in.** No root `install` script is defined, because pnpm would run it as a lifecycle hook on every install.
- **Added variables beyond PRD section 19.** `SOLANA_CAIP2_NETWORK` (optional, devnet-only), ports, bind host, data/secrets dirs and per-service credential paths. All are documented in docs/configuration.md.
- **The provider key reaches only the gateway process.** Every other process removes `OPENROUTER_API_KEY` from its environment at startup. The runner also drops the sponsor/owner/other-service credential paths.
- **Unfunded program keypair from builds.** `anchor build` (via `cargo build-sbf`) writes an unfunded program keypair to gitignored `target/deploy/`. It was deleted after verification and is not the deployment identity. `declare_id!` uses a keyless placeholder until T09.
