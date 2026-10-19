# Marketplace implementation triage

**Reassessed against `main` at `59696dd` (PR #3).** The marketplace is implemented in code: `services/marketplace`, 19 Supabase migrations (all applied to the project), the seller-host gateway profile, the control bridge and the `/marketplace/*` dashboard pages. This page maps each gate and each §26.6 check to the evidence that exists. It is source inspection plus recorded runs, not a new test run. The required product scope is [marketplace requirements](./marketplace.md); none of it is dropped.

Evidence kinds used below:

- **RLS e2e (live):** `pnpm test:marketplace-rls` (`scripts/marketplace/rls-e2e.ts`), 84/84 passed against the Supabase project with real Web3 sign-ins. Its chain reads use a labeled fixture, so it proves identity, RLS, Storage and transitions, not settlement.
- **Unit (fakes):** Vitest suites such as `services/control/test/marketplace.test.ts`, `services/marketplace/test/marketplace.test.ts` and `services/gateway/test/seller-host.test.ts`, part of `pnpm test` (944 passing on the PR #5 head `bff924e`; see [current status](./status.md)).
- **Devnet smoke (public funding):** two `marketplace-devnet-smoke-*.json` records in `artifacts/evidence/`, before PR #3 merged. The payer was funded publicly, not from the pool.

## Delivery gates T17–T23

| Task | State on `main` | Evidence | Still needed |
|---|---|---|---|
| T17 Discovery | **Done.** Contracts frozen in `packages/contracts/src/marketplace` | Contract unit tests | — |
| T18 Identity and protected data | **Done** for isolation | RLS e2e (live): anonymous, buyer A, buyer B, seller, controller and seller host; API, PostgREST, RPC and Storage | — |
| T19 Generic agents and free jobs | **In progress.** `custom` role with `marketplace_search` and `propose_hire` | Unit (fakes) | A free (zero-price) job path; none exists |
| T20 Direct paid hiring | **In progress.** Seller-host profile, per-listing payout, local approval or grant, payer proof of possession | RLS e2e (live); unit (fakes); devnet smoke (public funding) | A private-pool-funded hire on devnet |
| T21 Discovery and approved automation | **In progress.** Proposals, listing grants, dashboard Local approval | Unit (fakes) | A devnet run |
| T22 Connectors and remote sellers | **In progress.** Public-https remote sellers, scoped seller-host credentials, read-only MCP connectors | RLS e2e (live) connector checks; one live MCP call through control | Credential broker, an MCP tool run through a seller host on devnet, a genuine remote-seller devnet job |
| T23 Recovery and release | **In progress.** Refunds with chain verification, expiry sweep, lease fencing, late-receipt settlement | RLS e2e (live) refund and lease rules | Live refund transfer, offline-controller and stale-worker drills, content retention |

[Build status](../build-status.md) T17–T26 holds the detailed history.

## Acceptance matrix — all 14 §26.6 checks

None of these rows is closed with devnet settlement evidence for a private-pool-funded hire. "Covered" means the named check exists and passed; it does not mean the release gate is complete.

| ID | Required check | Evidence on `main` | Status |
|---|---|---|---|
| MKT-01 | Connected but unsigned wallet cannot read private records | RLS e2e: anonymous users cannot read jobs or listing versions | **Covered (RLS e2e, live)** |
| MKT-02 | Buyer A cannot read buyer B's data | RLS e2e: through the API, the database API, briefs, download links and Storage directly | **Covered (RLS e2e, live)** |
| MKT-03 | Seller sees assigned jobs only and cannot mutate price, recipient, participants or payment | RLS e2e: seller cannot change a quote's recipient or approve the buyer's job, cannot read the buyer's payer, sees its assigned job; clients cannot call transition functions | **Covered for recipient/state (RLS e2e, live)**; no explicit price or participant tamper check |
| MKT-04 | Wallet switching cannot transfer ownership | No dedicated check | **Not yet run** |
| MKT-05 | Changed recipient/mint/network/amount, expired quote or unapproved seller rejected locally | Unit (fakes): different digest/recipient/total authorizes nothing; seller-host recipient mismatch refused before funding; expired quote pays nothing; quote above maximum rejected | **Covered (unit, fakes)**; no devnet run |
| MKT-06 | Concurrent hires stay within all budgets | Unit (fakes): concurrent hires cannot exceed the agent or workspace cap | **Covered (unit, fakes)** |
| MKT-07 | One receipt funds one job and one earnings event | RLS e2e: one settlement signature cannot fund a second job, duplicate evidence is a no-op (fixture chain); devnet smoke: one job, earnings with fee 0 | **Covered (RLS e2e with fixture chain; public-funding devnet smoke)** |
| MKT-08 | Lost replies and post-settlement worker crash do not duplicate payment | Unit (fakes): lost seller reply reconciles the same operation; evidence re-sent after a lost reply without a second payment | **Covered (unit, fakes)**; no kill/drop drill on devnet |
| MKT-09 | Settled-but-failed jobs remain visibly paid | Unit (fakes): seller host stays visibly paid while the job cannot be claimed; definite provider failure reported as failure | **Covered (unit, fakes)** |
| MKT-10 | Refunds never exceed settled payment | RLS e2e: single and cumulative refunds capped; return address must be the buyer's verified wallet; only the assigned seller decides | **Covered for rules (RLS e2e, live)**; no live refund transfer |
| MKT-11 | Stale lease cannot complete a job | RLS e2e: second live lease refused; wrong lease token refused; hash-mismatched artifact refused | **Covered (RLS e2e, live)** |
| MKT-12 | Malicious result files cannot run scripts in app origin | Artifacts start quarantined (migration `…0002`); downloads use short-lived signed links with `download` disposition | **Partial**; no hostile HTML/SVG test |
| MKT-13 | Offline controller means no new spending | Payment requires a local approval or grant applied by control, which connects outbound only | **By design; no offline drill recorded** |
| MKT-14 | No pool-contract change solely for marketplace | Since marketplace work began, the only program source change is the `declare_id!` update in `5e381fc` for the redeployed program `27Dg…AjFd`; `492f481` changed only the build/test scripts | **Source inspection only**; no formal manifest comparison recorded |

For each row a release record still needs the tested commit and environment, actors, scenario, expected and observed results, failures or skips, and redacted artifacts. Paid acceptance needs devnet seller settlement from a private-pool-funded hire; fixtures and local signatures cannot fill it. MKT IDs label requirements; they are not test names.

## External setup and remaining decisions

The Supabase project is configured and migrated. Still external: reviewed seller endpoints and identities, operator-funded inference, devnet RPC and facilitator availability, and USDC/SOL for Solana devnet sponsorship. Higgsfield, MakeUGC and Zernio are not configured; the demo shows "Provider not configured" for them by owner decision. Hosted runtime isolation and a credential broker are still open implementation choices. Service keys stay server-side; an authenticated session alone does not prove tenant isolation or local spending approval.

Supabase's [Web3 sign-in](https://supabase.com/docs/guides/auth/auth-web3), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security) and [Storage access control](https://supabase.com/docs/guides/storage/security/access-control) documentation describes the platform features used; the RLS e2e results above are the Veilo-specific evidence.
