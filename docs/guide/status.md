# Evidence and current status

Documentation now includes PRD v3.2 §26 and T17–T23. Implementation findings use docs-branch snapshot `8bfe4a2` (application baseline `fe13778`), with separately identified parallel-branch observations checked on 17 October 2026. These are recorded results, not a new execution of product tests or an independent audit. The PRD describes requirements; it is not evidence of completion.

| Feature / environment | Status | Evidence and limits |
|---|---|---|
| M2 pool deposit, authenticated insertion, approved root, Groth16 withdrawal, change insertion and original/change public exits | **verified on devnet** | [M2 summary](https://github.com/Seann004/Veilo-agent-wallet/blob/fe13778/artifacts/evidence/m2-summary.json) and its eight companion files, recorded 16 October. Two synthetic participants; small set, no measured anonymity. |
| M2 fresh-wallet merchant payment | **verified on devnet** | [Merchant record](https://github.com/Seann004/Veilo-agent-wallet/blob/fe13778/artifacts/evidence/m2-merchant.json): PayAI Echo, 10,000 base units; Echo refunds payments. The operator-confirmed smoke stands in for control authority. This was not the Veilo gateway, credit issuance or an autonomous agent run. |
| Integrated private payments, credits, idempotency, cap races, revoke, crash recovery and backup/restore | **verified on local test validator** | [Integration report](https://github.com/Seann004/Veilo-agent-wallet/blob/fe13778/artifacts/evidence/integration-2026-10-17T00-36-54-669Z.json): 30 passed, 0 failed, 0 skipped. Separate services, on-chain Groth16 verification, self-hosted x402 facilitator; **fixture / mock provider** for inference. Local signatures are not devnet signatures. |
| Shawn, Prince and Mira complete workflow rehearsal | **verified on local test validator**; **fixture / mock provider** | `docs/build-status.md` T11–T15 records `pnpm demo:run -- --local-rehearsal`, steps a–g. Rehearsal outputs live under ignored `work/demo-rehearsal/evidence/`; not bundled in this checkout. Research is fictional CC0 demo fixture data in either environment. |
| Complete Veilo gateway/private agent acceptance: autonomous top-up, research/content and bounded live inference | **not yet run to an accepted result in this checkout** | Parallel deployment branch `96dac1d` records an earlier devnet gateway execution, but its state, gateway ledger, live inference receipts and task artifacts are absent here. Recover and review those files before another paid run; chain settlement alone cannot prove completed jobs. |
| Dashboard with funded devnet activity and browser-wallet signing | **not yet run** | T14 records local backend-driven UI checks and unfunded screenshots. A real extension sign-in/deposit/exit and funded screenshots remain outstanding. |
| Policy/session/runner/program negative cases outside the integration report | **fixture / mock provider** where applicable; devnet acceptance **not yet run** | Unit, real-proof and LiteSVM results are recorded in [build status](../build-status.md). These are local checks, not a local test-validator run unless explicitly recorded as such. |

The M2 artifact set above supports the specific **verified on devnet** label here; later parallel-branch chain observations are not promoted into complete agent or marketplace acceptance. Historical ordinary x402 and standalone provider smoke files are separate baselines; neither proves the integrated agent demo. No page claims audit, mainnet readiness, proof-enforced budgets or metadata anonymity.

## Marketplace extension — accepted scope, not yet verified

| Requirement group | Status in this checkout | Next gate |
|---|---|---|
| Reviewed searchable listings, seller setup and wallet identity | **not yet run**; no implemented marketplace flow | T17 inventory/schema freeze, then T18 Supabase identity/data isolation |
| Generic templates, private jobs, missing-input requests and deliverables | **not yet run**; existing roles/content artifacts are local foundations | T19 free execution with lease/crash/result checks |
| Direct seller hiring, zero fee, receipts and earnings history | **not yet run**; managed gateway has one merchant | T20 per-listing recipients and one-receipt/one-job/one-earnings verification |
| Approved discovery/automation, connectors and remote sellers | **not yet run** | T21–T22 permission/callback/grant tests and genuine devnet seller job |
| Seller refunds, offline/stale-worker handling and release acceptance | **not yet run** | T23 and all fourteen §26.6 checks |

Supabase and marketplace inclusion are already accepted product scope. Their absence here is an implementation gap, not a reason to drop requirements. The [marketplace guide](./marketplace.md) and [complete triage](./marketplace-triage.md) distinguish reusable code, gaps and exact closure evidence.

## Sources of truth

- [Build status](../build-status.md) owns task/gate history; stale historical phrases are listed in the [handoff](../handoff.md).
- [Security evidence](../security/evidence.md) maps recorded checks to acceptance cases.
- [Demo script](./demo.md) lists the eight operator steps and missing evidence.
- [Deployment](../deployment.md), [configuration](../configuration.md) and [protocol](../protocol.md) describe executable setup and the implemented algorithms.

The owner-controlled host remains trusted. Deposits, amounts, fresh payout wallets, merchant transfers, fees and timing are public. Removing an explicit spent-note identifier is narrower than anonymity; see [privacy](./privacy.md).
