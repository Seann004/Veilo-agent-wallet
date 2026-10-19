# Evidence and current status

Reviewed on 19 October 2026 against source `b155f17`, based on merged `main` `55e6404`, plus the accompanying submission documentation. Recorded results are not an independent audit. The PRD describes requirements, not completion. USDC payments use **Solana devnet** test tokens with no monetary value. CoinGecko market data concerns real public market prices and is separate from devnet pool pricing.

## Checks on the reviewed tree

The full suite on the local tree before the evidence-export fix passed **989 tests with 1 skipped across 126 files**. After the fix, the final full suite passed **994 tests with 1 skipped across 127 files**. Typecheck and lint passed. The new regression cases and scope are recorded in the [submission review](../submission-review-2026-10-19.md). The exporter now records its checkout provenance without claiming that historical transactions ran on that revision.

The earlier PR #5 result, 944 passed / 1 skipped on `bff924e`, is historical. Typecheck and lint passed on the reviewed tree. The RLS suite was not rerun: its prior 84/84 uses fixture chain reads and proves tenant controls, not settlement.

`pnpm test:integration`, `pnpm test:program`, `pnpm test:circuits` and a fresh devnet demo were not rerun in this submission pass. Local development proof artifacts are present for the automated suite. Operator signing, paid provider calls, catalogue activation and publishing remain separate steps.

## Behaviour added since the recorded runs

| Feature | Status | Evidence and limits |
|---|---|---|
| Owner-approved devnet swap (USDC to SOL on the pinned Orca whirlpool, agent picks an amount up to the owner's maximum per swap) | **ran on devnet before the latest changes** | Three swaps finalized without error on 2026-10-17/18 (relayer ledger, confirmed on chain). The current code is unit-tested against fakes only; no evidence file exists under `artifacts/evidence/`. Known gaps are listed in [payments](./payments.md#devnet-swap). |
| Agents on the owner's own model key | in code; tested against fakes | Live provider tests through Settings were made by the developer (OpenRouter GLM models); no recorded evidence file |
| Read-only web browsing for custom agents | in code; tested with a real local Chrome refusal check | No recorded devnet or production run |
| Result delivery to Telegram, Slack or Discord | in code; tested against fakes | No recorded live delivery |
| CoinGecko market data (`coingecko-market` templated tools) | one live call of each template through control on 2026-10-19 (HTTP 200) | Not seeded into the live marketplace; the work/marketplace-seed state has no `coingecko-market` step |
| Reference image style for custom agents | in code; tested against fakes | Requires the owner's model key; no recorded run |

## Recorded evidence (pre-merge)

| Feature / environment | Status | Evidence and limits |
|---|---|---|
| M2 pool deposit, authenticated insertion, approved root, Groth16 withdrawal, change insertion and original/change public exits | **verified on devnet** | [M2 summary](https://github.com/Seann004/Veilo-agent-wallet/blob/59696dd/artifacts/evidence/m2-summary.json) and its eight companion files, recorded 17 October against the deployment named in those files. Two synthetic participants; small set, no measured anonymity. |
| M2 fresh-wallet merchant payment | **verified on devnet** | [Merchant record](https://github.com/Seann004/Veilo-agent-wallet/blob/59696dd/artifacts/evidence/m2-merchant.json): PayAI Echo, 10,000 base units; Echo refunds payments. Not the Veilo gateway or an agent run. |
| Integrated private payments, credits, idempotency, cap races, revoke, crash recovery and backup/restore | **verified on local test validator** | [Integration report](https://github.com/Seann004/Veilo-agent-wallet/blob/59696dd/artifacts/evidence/integration-2026-10-17T00-36-54-669Z.json): 30 passed, 0 failed, 0 skipped. On-chain Groth16 verification, self-hosted x402 facilitator, **fixture / mock provider** for inference. Local signatures are not devnet signatures. |
| Shawn, Prince and Mira eight-step demo with live inference | **verified on devnet** (pre-merge run) | Run `2026-10-17-1eba868c`, program `27Dg…AjFd`: all 11 acceptance checks in [summary.json](https://github.com/Seann004/Veilo-agent-wallet/blob/59696dd/artifacts/evidence/demo-2026-10-17-1eba868c/summary.json) pass. Three private x402 purchases (credit pack, research dataset, content package) each delivered once to the gateway merchant; live DeepSeek V4 Flash calls via the operator's OpenRouter account per [inference-receipts.json](https://github.com/Seann004/Veilo-agent-wallet/blob/59696dd/artifacts/evidence/demo-2026-10-17-1eba868c/inference-receipts.json); no fixture provider call. Research sources are still fictional CC0 demo data. Recorded before PR #3 merged; no fresh post-merge run yet. Details: [demo checklist](./demo.md) and [deployment](../deployment.md). |
| Shawn unattended scheduler top-up | **not yet run** on devnet | The demo invokes Shawn's check explicitly; it does not prove a scheduler-triggered top-up. |
| Dashboard with funded devnet activity and browser-wallet (Phantom) signing | **not yet run** | Local backend-driven UI checks and unfunded screenshots exist (build status T14). The demo run signed with owner-local key files, not a browser wallet. |
| Marketplace direct hire, public funding | **verified on devnet** (pre-merge) | [Smoke 05:47](https://github.com/Seann004/Veilo-agent-wallet/blob/59696dd/artifacts/evidence/marketplace-devnet-smoke-2026-10-17T05-47-34-935Z.json) and [smoke 06:55](https://github.com/Seann004/Veilo-agent-wallet/blob/59696dd/artifacts/evidence/marketplace-devnet-smoke-2026-10-17T06-55-19-957Z.json): 10,000 base units each to the seller's payout ATA, chain-verified receipt, one job succeeded, earnings with platform fee 0. The payer was funded publicly, **not** from the private pool. |
| Marketplace hire funded from the private pool through the control bridge | **not yet run** on devnet | Implemented and tested against fakes (build status T20). |
| Workflow run, QuickNode x402 paid call, MCP tool through a seller host | **not yet run** on devnet | QuickNode returned a live 402 challenge on 17 October; no paid call recorded. One live read-only MCP docs-search call went through control (build status T26), and each CoinGecko template once on 19 October; no seller-host MCP run. |
| Higgsfield, MakeUGC and Zernio | **unverified** | No paid or posting call is recorded. Zernio TikTok carousel drafting, the slide designer and opt-in public posting (`ZERNIO_PUBLISH_MODE=publish`) are seller-host tools in code, tested against fakes; the only live Zernio contact recorded in commits is the free creator-info read made by `pnpm marketplace:carousel-preflight`. Without seller keys these tools show as "Provider not configured". |
| Policy/session/runner/program negative cases outside the integration report | **fixture / mock provider** where applicable | Unit, real-proof and LiteSVM results are recorded in [build status](../build-status.md). |

No page claims audit, mainnet readiness, proof-enforced budgets or metadata anonymity.

## Marketplace — implemented in code, devnet acceptance incomplete

The marketplace service, Supabase schema/RLS, seller host, control bridge and dashboard pages are on `main`. The table maps each group to what the RLS end-to-end script (`scripts/marketplace/rls-e2e.ts`) and other recorded runs actually cover.

| Group | In code on `main` | Covered by recorded checks | Still needs |
|---|---|---|---|
| T17 contracts | Frozen in `packages/contracts/src/marketplace` (quote digest, zero-fee arithmetic, job/financial states) | Contract unit tests | — |
| T18 identity and protected data | Supabase Web3 sign-in, workspaces, reviewed listings, RLS, private Storage, transition functions | RLS script: anonymous / buyer A / buyer B / seller / controller / seller host isolation through API, PostgREST, RPC and Storage; clients cannot call transition functions; seller cannot approve own listing | — for the isolation gate |
| T19 generic agents | `custom` role and template, `marketplace_search` / `propose_hire` tools | Unit tests | A free (zero-price) job path; none exists yet |
| T20 direct paid hiring | Seller-host gateway profile, per-listing payout, controller bridge with local approval, payer binding | RLS script: immutable quote, recipient cannot change, replayed controller request refused, payer bound once, one settlement signature cannot fund a second job, no lease before settlement; devnet smoke with public funding | A private-pool-funded hire on devnet |
| T21 discovery and approved automation | Custom agents propose hires; listing grants; dashboard Local approval page | Unit tests against fakes | A devnet run |
| T22 connectors and remote sellers | Public-https remote seller origins, scoped seller-host credentials, read-only MCP connectors with operator review | RLS script: proposed connector private until approved, withdrawn connector removes dependent workflows; one live MCP call through control | A credential broker, an MCP tool run through a seller host on devnet, a genuine remote-seller devnet job |
| T23 recovery and release | Refund requests/decisions with chain verification, expiry sweep, lease fencing, late-receipt settlement | RLS script: refund capped at settled amount (also cumulatively), return address must be the buyer's verified wallet, stale/wrong lease token refused, hash-mismatched artifact refused | A live refund transfer, offline-controller and stale-worker drills, content retention |
| T24–T26 tools, workflows, agent connectors | External x402 bindings, workflow runner, MCP connectors, dashboard builder/runs | RLS script workflow and tool checks; seed of demo creators/tools/workflows | A multi-step devnet workflow run and paid tool calls |

The per-check view is in [marketplace triage](./marketplace-triage.md).

## Sources of truth

- [Build status](../build-status.md) owns task/gate history.
- [Security evidence](../security/evidence.md) maps recorded checks to acceptance cases.
- [Demo checklist](./demo.md) lists the eight operator steps, the recorded run and remaining screenshots.
- [Deployment](../deployment.md), [configuration](../configuration.md) and [protocol](../protocol.md) describe setup and algorithms.

The owner-controlled host remains trusted. Deposits, amounts, fresh payout wallets, merchant transfers, fees and timing are public. Removing an explicit spent-note identifier is narrower than anonymity; see [privacy](./privacy.md).
