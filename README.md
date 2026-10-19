# Veilo

Veilo is a single-owner workspace for AI agents on Solana devnet. Owners configure jobs, approved services and spending limits; an independent control/wallet service authorizes purchases. A Groth16 note pool can fund fresh payment wallets, which make ordinary x402 merchant transfers. PRD v3.2 adds a marketplace where buyers hire reviewed specialist agents and run published workflows, and sellers receive direct payments; it is implemented in code on `main`, with devnet acceptance still incomplete. The owner retains local attribution; amounts, wallets, merchant payments and timing remain public.

## Current status

Amounts are USDC on **Solana devnet**. Full detail: [current status](docs/guide/status.md).

- **Current tree (`59eb491`):** `pnpm check` passes; `pnpm test` 944 passed, 1 skipped on the PR #5 head `bff924e` (full runs on a heavily loaded machine can time out; the affected suites pass on their own). `pnpm test:marketplace-rls` was 84/84 at `59696dd` and was not rerun.
- **verified on devnet (pre-merge):** the Shawn/Prince/Mira demo run [`2026-10-17-1eba868c`](artifacts/evidence/demo-2026-10-17-1eba868c/summary.json), all 11 acceptance checks: three private x402 purchases delivered once to the Veilo gateway, live DeepSeek V4 Flash inference through the operator's OpenRouter account, duplicate/over-budget/revoke checks and an owner exit. Research sources are fictional CC0 demo data. Also the earlier [M2 private-pool run](artifacts/evidence/m2-summary.json) and two marketplace hires settled directly to a seller with a **publicly funded** payer.
- **verified on local test validator:** private payments, credits, concurrency, revoke, fault recovery and encrypted restore; [30/30 integration cases](artifacts/evidence/integration-2026-10-17T00-36-54-669Z.json), with a **fixture / mock provider**.
- **in code, not yet run on devnet:** an owner-approved USDC to SOL swap (Orca devnet, the agent picks an amount up to the owner's maximum per swap), agents on the owner's own model key, read-only browsing, result delivery to Telegram/Slack/Discord, reference images, and CoinGecko market data through pinned templates (one live call per template; not yet seeded into the live marketplace).
- **not yet run:** a fresh post-merge devnet run, the funded dashboard with browser-wallet (Phantom) signing, a private-pool-funded marketplace hire, a devnet workflow run, a paid QuickNode x402 call and an MCP tool run through a seller host. Higgsfield, MakeUGC and Zernio are **unverified** and appear as "Provider not configured" without seller keys.

This is an unaudited prototype with a deterministic development trusted setup whose toxic waste is derivable. Use Solana devnet funds only. Local caps are off-chain controls; pool membership is not an anonymity score. See [current status](docs/guide/status.md), [build status](docs/build-status.md) and [known risks](docs/security/risks.md).

## Marketplace (PRD v3.2)

Reviewed specialist listings, seller onboarding, one specialist per hire, private jobs/deliverables/receipts, published workflows over reviewed tools, read-only MCP connectors, direct x402 seller payments with an explicit zero platform fee, and earnings shown as finalized receipt history. Supabase Auth/Postgres/private Storage hold marketplace identity and product data; local control/wallet remain the spending authority. Every workspace still has one owner, and the local stack runs without Supabase.

The marketplace service, 19 Supabase migrations, seller-host profile, control bridge and dashboard pages are on `main`. Free (zero-price) jobs, a credential broker, a hosted sandbox and content-retention cleanup are not built. See the [marketplace guide](docs/guide/marketplace.md) and the [T17–T23 triage with all 14 acceptance checks](docs/guide/marketplace-triage.md).

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

Control owns allowance accounting; the gateway owns shared service credits. Models cannot sign arbitrary transfers or change policies. Agents' model work runs on the owner's own provider key, which control seals and never hands to an agent; without one, planning uses an operator-sponsored OpenRouter trial. Devnet USDC and gateway credits are not provider dollars.

The [documentation site](docs/index.md) contains [architecture/diagrams](docs/guide/architecture.md), [payment algorithms](docs/guide/payments.md), [protocol](docs/protocol.md), [security assessment](docs/security/assessment.md) and the [eight-step demo](docs/guide/demo.md).

## Quickstart

Install **Node 24 LTS** (`engines` allows `>=22.14.0 <25`; see `.nvmrc`), **pnpm 10.34.6** and **Docker** with a Linux daemon. Rust, Solana, Anchor and circom run in the pinned toolchain image.

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

`pnpm dev` starts the backend services and the dashboard dev server (webpack) on `http://localhost:3000`, which must match `VEILO_DASHBOARD_ORIGIN`. `/` is the public landing page; the owner workspace is `/workspace`; add your model key in `/settings`. Sign in with the configured owner wallet on devnet, review/activate policies, and follow the [deployment runbook](docs/deployment.md) before funding/purchasing. `demo:seed` never issues credits. Operator-paid inference (the planning trial, paid SKUs and `demo:run`) requires a separately funded OpenRouter account, allowlisted models and an explicit operator cost ceiling. Docker image/registry access, devnet RPC, sponsor SOL, the test mint and a compatible facilitator are external dependencies.

For real-proof local rehearsal, build circuits/program first; see [running Veilo](docs/guide/running.md). For the operator demo, `pnpm demo:run` checks readiness without signing/provider calls; execution requires both `--execute --confirm`.

## Root commands

This table covers every script in the root `package.json`. Signing, paid inference, restore and key-generation commands have the prerequisites described above and in their runbooks.

| Command | Purpose |
|---|---|
| `pnpm setup:local` | Validate toolchain/configuration; prepare directories and configured encryption root |
| `pnpm dev` | Start the dashboard (port 3000) and five backend services, plus the marketplace and seller host when Supabase is configured, and the carousel seller host when its settings are present |
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
| `pnpm test:marketplace-rls` | Live identity/RLS/Storage/transition checks against the configured Supabase project (fixture chain reads) |
| `pnpm marketplace:devnet-smoke` | Devnet hire with a publicly funded payer; signs only with `--confirm` |
| `pnpm marketplace:operator` | Operator CLI: review sellers, listings, workflows, tools and connectors; issue seller-host credentials; sweep expiries |
| `pnpm marketplace:seed` | Read-only plan for demo creators, tools, connectors (including `coingecko-market`) and workflows; `--confirm` creates devnet token accounts and catalogue rows |
| `pnpm marketplace:carousel-preflight` | Check the TikTok carousel workflow can run, without spending or posting (makes two free Zernio reads) |

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
