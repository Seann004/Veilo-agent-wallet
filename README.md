# Veilo

Veilo is a single-owner workspace for AI agents on Solana devnet. Owners configure jobs, approved services and spending limits; an independent control/wallet service authorizes purchases. A Groth16 note pool can fund fresh payment wallets, which make ordinary x402 merchant transfers. PRD v3.2 adds a marketplace where buyers hire reviewed specialist agents and sellers receive direct payments; marketplace implementation is pending in this checkout. The owner retains local attribution; amounts, wallets, merchant payments and timing remain public.

## Current status

- **verified on devnet:** only the recorded [M2 private-pool run](artifacts/evidence/m2-summary.json), including a 0.01 test-USDC payment to **PayAI Echo**, not the Veilo gateway. It used synthetic participants and an operator-confirmed authority stand-in.
- **verified on local test validator:** private payments, credits, concurrency, revoke, fault recovery and encrypted restore; [30/30 integration cases](artifacts/evidence/integration-2026-10-17T00-36-54-669Z.json), with a **fixture / mock provider**.
- Shawn, Prince and Mira flows have only local rehearsal evidence with a **fixture / mock provider**. Research datasets are fictional CC0 demo data. Complete live-agent acceptance evidence is missing here. The parallel deployment branch reports an earlier devnet gateway execution without its run-state/receipt/task files in this checkout; recover/review that state before another paid run. Funded dashboard screenshots and browser-wallet signing are also pending.

This is an unaudited prototype with a deterministic development trusted setup whose toxic waste is derivable. Use devnet test funds only. Local caps are off-chain controls; pool membership is not an anonymity score. See [current status](docs/guide/status.md), [build status](docs/build-status.md) and [known risks](docs/security/risks.md).

## Marketplace extension (PRD v3.2)

Accepted scope includes reviewed searchable specialist listings, seller onboarding, one specialist per hire, private job inputs/deliverables/receipts, direct x402 seller payments, explicit zero platform fees and earnings shown as finalized receipt history. Supabase Auth/Postgres/private Storage hold marketplace identity and product data; local control/wallet remain the spending authority. Every workspace still has one owner, and the original local stack must run without Supabase.

**Marketplace acceptance: not yet run in this checkout.** Fixed execution roles, a single-merchant managed gateway and absent cloud identity/job/receipt workflows are concrete gaps. Read the [marketplace guide](docs/guide/marketplace.md) and [T17–T23 triage with all 14 acceptance checks](docs/guide/marketplace-triage.md). These requirements do not imply marketplace features have shipped.

## Architecture at a glance

```text
Owner → Runner → Control (policy + atomic reservations)
                    ↓
                 Wallet (local notes/proofs + constrained signer)
                    ↓
              Relayer → Pool program → Fresh payment wallet
                                             ↓ ordinary x402
                                       Facilitator → Merchant/gateway
                                                          ↓
                                              Credits / bounded provider call
```

Control owns allowance accounting; the gateway owns shared service credits. Models cannot sign arbitrary transfers or change policies. OpenRouter is funded separately by the operator; test USDC and gateway credits are not provider dollars.

The [documentation site](docs/index.md) contains [architecture/diagrams](docs/guide/architecture.md), [payment algorithms](docs/guide/payments.md), [protocol](docs/protocol.md), [security assessment](docs/security/assessment.md) and the [eight-step demo](docs/guide/demo.md).

## Quickstart

Install **Node 24 LTS** (22.14+ also works; see `.nvmrc`), **pnpm 10.34.6** and **Docker** with a Linux daemon. Rust, Solana, Anchor and circom run in the pinned toolchain image.

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm toolchain:build
pnpm setup:local
pnpm check:devnet
```

Configure `.env` locally from [configuration](docs/configuration.md). For a fresh workspace, follow [running Veilo](docs/guide/running.md) to create service credentials, configure the wallet encryption root, seed draft policies and provision deployment roles. A clone contains no funded signing keys, proving keys or provider credentials. Do not reuse someone else's published deployment identities without their matching owner-local keys.

```sh
pnpm demo:seed
pnpm check
pnpm test
pnpm dev
```

Open `http://127.0.0.1:3000`, sign in with the configured owner wallet on devnet, review/activate policies, and follow the [deployment runbook](docs/deployment.md) before funding/purchasing. `demo:seed` never issues credits. Live inference requires a separately funded OpenRouter account, allowlisted models and an explicit operator cost ceiling. Docker image/registry access, devnet RPC, sponsor SOL, the test mint and a compatible facilitator are external dependencies.

For real-proof local rehearsal, build circuits/program first; see [running Veilo](docs/guide/running.md). For the operator demo, `pnpm demo:run` checks readiness without signing/provider calls; execution requires both `--execute --confirm`.

## Root commands

This table covers every script in the root `package.json`. Signing, paid inference, restore and key-generation commands have the prerequisites described above and in their runbooks.

| Command | Purpose |
|---|---|
| `pnpm setup:local` | Validate toolchain/configuration; prepare directories and configured encryption root |
| `pnpm dev` | Start dashboard and five backend services |
| `pnpm check` | Run type checking and lint |
| `pnpm typecheck` | Check root and workspace TypeScript |
| `pnpm lint` | Run ESLint with no warnings |
| `pnpm test` | Run workspace Vitest tests |
| `pnpm vectors:generate` | Generate protocol known-answer vectors; refuses differing output by default |
| `pnpm vectors:check` | Cross-check TypeScript, Python, Rust and circuit vectors (Docker required) |
| `pnpm test:circuits` | Build manifest-pinned development proving files and run real-proof tests (Docker) |
| `pnpm test:program` | Generate proof/SDK fixtures; build and run program/LiteSVM tests (Docker) |
| `pnpm test:integration` | Run local test-validator fault suite with mock inference (Docker) |
| `pnpm keys:init` | Create/validate local deployment role keys; never replace existing identities |
| `pnpm program:set-id` | Align program ID, Anchor configuration and IDL with role manifest |
| `pnpm deploy:devnet` | Read-only deployment plan; signing requires --execute --confirm |
| `pnpm demo:private-smoke` | Read-only M2 plan; signing requires --execute --confirm |
| `pnpm demo:seed` | Seed draft agents, catalog and shared account; no funds or credits issued |
| `pnpm demo:run` | Read-only devnet readiness; --local-rehearsal uses local validator/mock inference; live execution requires --execute --confirm |
| `pnpm evidence:export` | Export public manifests, evidence and latest demo ledger with secret scan |
| `pnpm backup` | Write encrypted wallet/control snapshot; keep encryption root separately |
| `pnpm restore` | Restore encrypted snapshot; --file required; stop writers and reconcile |
| `pnpm check:devnet` | Read-only finalized genesis and mint checks |
| `pnpm toolchain:build` | Build pinned Docker toolchain image |
| `pnpm tc` | Run a toolchain command in Docker using -- <command> |

`pnpm install --frozen-lockfile` is pnpm's built-in dependency install, not a root script. Use `pnpm evidence:export` after the operator run; inspect output before publication. See [evidence mapping](docs/security/evidence.md) and [handoff gaps](docs/handoff.md).

## Documentation development

```sh
cd docs
npm ci
npm run dev
# Production validation:
npm run build
npm run preview
```

Default base: `/Veilo-agent-wallet/`; use `DOCS_BASE=/ npm run build` for a custom domain root. Builds regenerate `llms.txt`, the intentional `llms.text` compatibility alias and `llms-full.txt`. Documentation builds do not execute product tests.

## Attribution and license status

[zx402](https://github.com/Marcussy34/zx402) by Marcus Tan is the architectural reference (snapshot `9da88d099bb1ad28c0de3e2b0b7e15e2a1fd198d`): note pools, proof-based withdrawal, hidden change, fresh-payer x402 and owner exit. Privacy Pools supplies architectural lineage; Veilo does not claim invention of these ideas. Original Cardano transactions are not Veilo Solana evidence.

[NOTICE](NOTICE) preserves the upstream MIT notice and identifies reused/adapted sources and dependency licenses. The [source/license map](docs/references/attribution.md) records direct dependencies and review gaps. **The owner has not selected Veilo's own license; no root LICENSE is assigned here.** Dependency licenses, including GPL components, retain their own terms.
