# Evidence and current status

Documentation checked against source snapshot `fe13778` and the recorded build status on 17 October 2026. These are recorded results, not a new execution of product tests or an independent audit. The PRD describes requirements; it is not evidence of completion.

| Feature / environment | Status | Evidence and limits |
|---|---|---|
| M2 pool deposit, authenticated insertion, approved root, Groth16 withdrawal, change insertion and original/change public exits | **verified on devnet** | [M2 summary](https://github.com/Seann004/Veilo-agent-wallet/blob/fe13778/artifacts/evidence/m2-summary.json) and its eight companion files, recorded 16 October. Two synthetic participants; small set, no measured anonymity. |
| M2 fresh-wallet merchant payment | **verified on devnet** | [Merchant record](https://github.com/Seann004/Veilo-agent-wallet/blob/fe13778/artifacts/evidence/m2-merchant.json): PayAI Echo, 10,000 base units; Echo refunds payments. The operator-confirmed smoke stands in for control authority. This was not the Veilo gateway, credit issuance or an autonomous agent run. |
| Integrated private payments, credits, idempotency, cap races, revoke, crash recovery and backup/restore | **verified on local test validator** | [Integration report](https://github.com/Seann004/Veilo-agent-wallet/blob/fe13778/artifacts/evidence/integration-2026-10-17T00-36-54-669Z.json): 30 passed, 0 failed, 0 skipped. Separate services, on-chain Groth16 verification, self-hosted x402 facilitator; **fixture / mock provider** for inference. Local signatures are not devnet signatures. |
| Shawn, Prince and Mira complete workflow rehearsal | **verified on local test validator**; **fixture / mock provider** | `docs/build-status.md` T11–T15 records `pnpm demo:run -- --local-rehearsal`, steps a–g. Rehearsal outputs live under ignored `work/demo-rehearsal/evidence/`; not bundled in this checkout. Research is fictional CC0 demo fixture data in either environment. |
| Veilo gateway private devnet credit purchase, autonomous top-up, paid research/content with live bounded inference | **not yet run** | `pnpm demo:run -- --execute --confirm` remains the operator gate. A dry run is not a payment or provider call. Separate OpenRouter smoke evidence does not complete these workflows. |
| Dashboard with funded devnet activity and browser-wallet signing | **not yet run** | T14 records local backend-driven UI checks and unfunded screenshots. A real extension sign-in/deposit/exit and funded screenshots remain outstanding. |
| Policy/session/runner/program negative cases outside the integration report | **fixture / mock provider** where applicable; devnet acceptance **not yet run** | Unit, real-proof and LiteSVM results are recorded in [build status](../build-status.md). These are local checks, not a local test-validator run unless explicitly recorded as such. |

Only the M2 evidence above is labeled **verified on devnet** here. Historical ordinary x402 and standalone provider smoke files are separate baselines; neither proves the integrated agent demo. No page claims audit, mainnet readiness, proof-enforced budgets or metadata anonymity.

## Sources of truth

- [Build status](../build-status.md) owns task/gate history; stale historical phrases are listed in the [handoff](../handoff.md).
- [Security evidence](../security/evidence.md) maps recorded checks to acceptance cases.
- [Demo script](./demo.md) lists the eight operator steps and missing evidence.
- [Deployment](../deployment.md), [configuration](../configuration.md) and [protocol](../protocol.md) describe executable setup and the implemented algorithms.

The owner-controlled host remains trusted. Deposits, amounts, fresh payout wallets, merchant transfers, fees and timing are public. Removing an explicit spent-note identifier is narrower than anonymity; see [privacy](./privacy.md).
