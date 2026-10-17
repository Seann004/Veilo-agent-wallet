# Marketplace implementation triage

**Assessment date: 17 October 2026.** This is documentation and source inspection, not a marketplace test run. No marketplace acceptance case has passed in this checkout. The required product scope is [PRD v3.2 §26](./marketplace.md); the triage retains all of it.

## Scope and source snapshot

The docs branch previously contained PRD v3.1. It now contains the byte-identical v3.2 amendment read from the main checkout, including §26 and backlog T17–T23. Spec SHA-256: `d4b4170e9880dc70654f1916a99a0cb36c2d4f66ab69b83c30fcca1a39b20d72`. The amendment was uncommitted in the main checkout when inspected; synchronizing this copy does not claim that another branch has been merged.

Implementation findings below refer to docs-branch source `8bfe4a2` (application baseline `fe13778`). The concurrent marketplace branch has a Phase 0 inventory and a draft limits module; those working files are not merged here and are not evidence of deployed identity, jobs or payments. The Phase 0 inventory's older proposals to make Supabase optional for the marketplace or defer managed templates do not override the accepted v3.2 scope. Supabase is required for the marketplace; it remains unnecessary for local T00–T16 operation.

## Reusable foundation and concrete gaps

| Area | Inspected source | Finding / required next work |
|---|---|---|
| Local authority | `services/control/src/http/actor.ts`, `auth/session.ts`, `ledger/authorize.ts` | Local wallet challenge, agent-scoped credentials and atomic reservations exist. Add a separate cloud identity and authenticated outbound connection without replacing local spending authority. |
| Agents and queue | `packages/db/migrations/control/0001_ledger.sql`, `services/runner/src/roles/` | Agent roles and job kinds are fixed; no generic specialist runtime or participant job board. T19 must generalize templates, leases, input requests and validated artifacts. |
| Service binding | `packages/x402-client/src/binding.ts`, control `approved_service` schema | Existing binding checks origin, network, mint, seller `payTo`, derived ATA, amount and allowed fee payer. This is reusable code, not a verified marketplace hire or arbitrary live seller support. |
| Managed merchant | `services/gateway/src/gateway.ts`, `purchases.ts` | Gateway uses one configured merchant. Block managed paid listings until per-listing recipient/version binding and direct settlement tests pass; never route seller payments through the operator. |
| Free execution | Control `service_sku` constraints and gateway API schemas | Existing purchase paths require positive USDC or credit usage. Define an explicit free quote/execution path; do not fake a settled payment or charge a nominal token to bypass this gap. |
| Cloud data / files | Workspace manifests and migrations | No Supabase client, marketplace schema/RLS, private Storage policy or transition API in this checkout. Tenant isolation and signed downloads are untested. |
| Results / earnings / refunds | Gateway purchase/result cache and control content artifacts | Existing local results and financial events are reusable; marketplace participant access, receipt-to-job/earnings uniqueness and seller-funded capped refunds are missing. |
| Hosted runtime / connectors | `services/runner/src/safe-fetch.ts`, restricted role tools | Local origin/tool checks exist. No hosted sandbox, credential broker, reviewed remote-seller callback authentication or grant-revocation flow is demonstrated. |

## T17 contract discovery is incomplete

The inventory can identify existing contracts; it cannot declare marketplace schemas frozen yet:

| Contract | Existing authoritative shape | Missing marketplace decision / evidence |
|---|---|---|
| Quote | `packages/contracts/src/gateway/api.ts`: operation, SKU, request digest; `QuoteView` adds account, recipient binding, charge, gateway, expiry and purchase state | Freeze listing/runtime/payout versions, participants, scope/input digest, explicit free or paid mode and zero-fee fields. Bind these to the local operation before any authority release. |
| Payment | `packages/contracts/src/control/states.ts`: authorization, funding, merchant, fulfilment and recovery are distinct; transition triggers and outbox/inbox already exist | Freeze cloud request/acknowledgement, expiry/replay/revocation rules and finalized receipt identity. A cloud projection cannot create local reservations or mark a payment settled. |
| Result | `services/gateway/src/purchases.ts`: authenticated cached result or explicit failure/uncertainty; local content artifact APIs | Freeze participant access, artifact validation, attempt/lease identity, late-result rejection and paid-but-failed handling. Define one receipt → one job → one earnings event. |

T17 requires the repository/commit, entry points, schemas/state machines, program/circuit/artifact identity, proof/recovery evidence, x402/facilitator/recipient rules, wallet boundary, auth, queue and deployment inventory. The existing M2 and local integration manifests supply a baseline; they do not verify marketplace behavior. No marketplace migration or pool-contract change should precede completion of this discovery gate. This documentation pass does not perform those changes.

## Delivery gates T17–T23

| Task | Dependencies | Current triage | Completion evidence required |
|---|---|---|---|
| T17 Discovery | T00–T08 | **In progress outside this checkout; not complete here.** Inventory exists, marketplace schemas are not frozen here. | Versioned inventory, agreed quote/payment/result schemas and explicit gaps before migration or contract work. |
| T18 Identity and protected data | T17 | **Not implemented here; not yet run.** | Supabase wallet sign-in, reviewed catalogue/seller setup, workspaces, grants/RLS and private Storage; anonymous, buyer A/B, seller and worker isolation tests. |
| T19 Generic agents and free jobs | T17–T18, T11–T13 | **Not implemented here; not yet run.** Fixed local roles are reusable foundations. | Template-driven agents; free job input, lease, result/download flow; duplicate/crash delivery leaves one current result. |
| T20 Direct paid hiring | T09, T19 | **Blocked** on marketplace contracts, verified recipients and receipt binding. | One finalized direct seller payment funds one job and one earnings event; explicit zero fee; ambiguous outcomes block replacement payments. |
| T21 Discovery and automation | T20 | **Not implemented here; not yet run.** | Search/propose, owner approval for new sellers, schedule dedupe and revoke; malicious listings cannot alter recipient, permissions or service approval. |
| T22 Connectors and remote sellers | T21 | **Not implemented here; not yet run.** | Reviewed MCP/API adapters, credential broker, authenticated callbacks, least-privilege/revoked-grant tests; a new seller earns from a genuine devnet job. |
| T23 Recovery and release | T22 | **Not implemented here; not yet run.** | Finalized capped seller refunds, uncertain settlement, offline/stale-worker behavior, restore/suspension and every §26.6 check below. |

Priority is to finish T17 before T18 changes, then follow the stated dependency graph. The remaining T11–T15 live-inference evidence is still required; marketplace documentation or a free mock job does not complete it.

## Acceptance matrix — all 14 §26.6 checks

Every row below is **not yet run for the marketplace**. Existing local/P0 tests are supporting foundations only.

| ID | Required check | Evidence needed to close it |
|---|---|---|
| MKT-01 | Connected but unsigned wallet cannot read private records | No authenticated cloud session: API/database/Storage deny private reads. |
| MKT-02 | Buyer A cannot read buyer B's data | Cross-tenant tests against transition APIs, direct exposed-table access and private Storage. |
| MKT-03 | Seller sees assigned jobs only and cannot mutate price, recipient, participants or payment | Seller role negative read/write tests and unchanged immutable quote/payment fields. |
| MKT-04 | Wallet switching cannot transfer ownership | Switch wallet/session; old workspace/job/file access is denied and ownership stays unchanged. |
| MKT-05 | Changed recipient/mint/network/amount, expired quote or unapproved seller rejected locally | Tamper each bound field and replay expiry/approval cases; no proof or merchant signature released. |
| MKT-06 | Concurrent hires stay within all budgets | Competing hires for final allowance; local reservations admit only fitting exposure. |
| MKT-07 | One receipt funds one job and one earnings event | Replay receipt across jobs/accounts and concurrently; unique finalized mapping persists after restart. |
| MKT-08 | Lost withdrawal/settlement replies and post-settlement worker crash do not duplicate payment | Kill/drop-response tests at cloud/local/seller boundaries, same operation reconciled, one settlement. |
| MKT-09 | Settled-but-failed jobs remain visibly paid | Seller/provider failure after finality; receipt retained, job failure shown separately from payment. |
| MKT-10 | Refunds never exceed settled payment | Cumulative/duplicate refund tests, owner-verified destination and finalized transfers only. |
| MKT-11 | Stale lease cannot complete a job | Expire/reassign lease, submit late result; old worker rejected, one current result retained. |
| MKT-12 | Malicious result files cannot run scripts in app origin | Hostile HTML/SVG/file tests for preview, downloads and MIME/disposition handling. |
| MKT-13 | Offline controller means no new spending | Disconnect local controller; no cloud action can release a proof/signature or bypass the paused state. |
| MKT-14 | No pool-contract change solely for marketplace | Program/circuit/manifest comparison and regression checks show reused private funding invariants. |

For each row attach the tested commit/environment, actors, exact scenario, expected/observed result, failures/skips and redacted artifacts. Attach actual devnet seller settlement/earnings evidence for paid acceptance; fixtures and local signatures cannot fill it. These documentation IDs label requirements; they are not implemented test names.

## External setup and remaining decisions

A selected/configured Supabase project, reviewed seller endpoints/identities, operator-funded inference where used, devnet RPC/facilitator availability and test-token/SOL sponsorship are external dependencies. Supabase adoption and marketplace inclusion are already owner decisions, not open scope questions. Deployment/provider credentials, hosted runtime isolation technology, exact frozen schemas and the operator publication/review process still need implementation choices and evidence. No runnable marketplace environment-variable contract is defined here; do not invent one or publish service keys.

Supabase's official [Web3 sign-in](https://supabase.com/docs/guides/auth/auth-web3), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security) and [Storage access-control](https://supabase.com/docs/guides/storage/security/access-control) documentation informs the planned boundary. Those product capabilities do not demonstrate Veilo's implementation. Keep service keys server-side; an authenticated session alone does not prove tenant isolation or local spending approval.
