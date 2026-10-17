# Marketplace handoff: Phase 0 inventory and stress test

Checked against `main` @ `fe13778` on 2026-10-17. This is a discovery record. It does not implement anything and claims nothing about marketplace behavior. Live devnet and macOS verification of the existing stack is being done separately on `fix/devnet-demo-run`.

## 1. Verdict

The handoff is sound on authority boundaries, money handling and privacy wording. Its premise is out of date, though, and it conflicts with the binding project scope:

1. **The handoff says the checkout holds only documentation. That is wrong.** This repository contains the full implementation: pool program, circuits, wallet, control, gateway, relayer, runner and dashboard. The "contracts elsewhere" are here.
2. **It conflicts with `PRD_latest.md`**, the authoritative spec that `CLAUDE.md` points to:
   - §4 "Do not require Supabase" and "local owner-operated single-user deployment". The handoff makes Supabase plus a hosted multi-tenant service core.
   - §1 and §22: P2 includes "multiple owners", and "Avoid building P1/P2 capabilities before P0 completion". A seller/buyer marketplace is multi-party.
   - P0 is **not complete**. A devnet `demo:run` executed on 2026-10-17 01:15–01:18 UTC: deposits, private withdrawals and three x402 payments to the gateway merchant are visible on chain. But its run state and evidence (real inference, task completion) are not in the repo, so T11–T13 and T15 remain unproven. T16 hasn't started.
3. **Resolved 2026-10-17:** the owner put the marketplace in scope with Supabase. `PRD_latest.md` v3.2 adds §26 and tasks T17–T23; the P0 stack must still run without Supabase. Still recommended: Finish the P0 devnet demo first. Then build a thin slice (§6) that reuses the existing per-service recipient binding, rather than starting Phases 1–6 in parallel with the submission.

## 2. Discovery inventory (handoff §2)

| # | Item | Finding |
|---|---|---|
| 1 | Repos / commits | Single monorepo `Seann004/Veilo-agent-wallet`, `main` @ `fe13778`. Contribution rules are in `CLAUDE.md`; there is no AGENTS.md. |
| 2 | Entry points | Dashboard: Next.js `apps/dashboard` (:3000). Control: `services/control` (:4101). Runner: `services/runner` (:4102). Wallet: `services/wallet` (:4103). Gateway: `services/gateway` (:4104). Relayer and indexer: `services/relayer` (:4105). Each runs as a separate process with its own credentials (`docs/configuration.md`). |
| 3 | Schemas / state machines | SQLite WAL, STRICT tables, integer base units. Control migrations: `packages/db/migrations/control/0001_ledger.sql`, `0002_auth.sql`, `0003_agents.sql`. Wallet secrets DB: `migrations/secrets/0001–0003`. Funding, merchant, fulfilment and recovery state transitions are enforced by DB triggers (`payment_transition`). Outbox/inbox, idempotency and append-only financial events already exist. |
| 4 | Program / circuits | Devnet program `3B6Db74gPstdciTfr1gdYG4DuhA2DpTGqYM9jgthYUrq`, PoolState `65FNWNc1…8Tab`, upgrade authority is the deployer role `38jQ…BTNR`, mint `4zMMC9…DncDU` (devnet USDC, 6 dp). Instructions: initialize_pool, deposit, insert_leaf, update_approved_root, spend_private, exit_public, refund_pending_deposit, update_config. There is no sweep/admin instruction. Verifying keys and the manifest are in `artifacts/circuits/`, program measurements in `artifacts/program/`. |
| 5 | Proof properties | Real Groth16 (`groth16-solana`). Withdrawal binding, nullifier consumption, change insertion and owner exit are covered by LiteSVM adversarial tests (T07) and were finalized on devnet (`artifacts/evidence/m2-*.json`). This has not been re-run on this Mac yet. |
| 6 | x402 | `@x402/core`, `@x402/svm` and `@x402/fetch` 2.28.0, V2 `exact`. The client (`packages/x402-client/src/binding.ts`) accepts only a requirement whose `payTo`, mint and network match an approved binding, and checks that the recipient ATA equals the derived ATA. The whole transaction is validated before signing, with a single-use signer and no auto-retry. The facilitator is PayAI in the devnet config, or a self-hosted `@x402/core` facilitator in local tests. **The gateway is single-merchant**: one `merchantAddress` (`services/gateway/src/gateway.ts:95`). |
| 7 | Wallet trust boundary | Note secrets, one-time keys and fresh signers live in the wallet's separate secrets DB under `OWNER_SERVICE_SECRET_PATH`, AEAD-encrypted. The runner never gets DB, signer or provider credentials. Control authorizes each funding stage; the relayer receives public material only. |
| 8 | Auth / deploy / queue | Owner auth is Control's own Ed25519 sign-in challenge (single-use nonce, domain/URI/expiry, HttpOnly SameSite=Strict cookie, CSRF and Origin checks), with a single `owner_pubkey UNIQUE` per workspace. The queue is control's durable SQLite scheduler with leases and heartbeats. Deployment is local only; there is no hosted service, no Supabase and no secrets manager. |

## 3. Handoff assumptions vs the code

| Handoff assumption | Reality | Impact |
|---|---|---|
| Arbitrary owner-created agents (§3) | `agent.role CHECK IN ('credit_manager','research','content')`, `job.kind CHECK IN ('credit_check','research','content','reconcile')`. Runner roles are code (`services/runner/src/roles/{prince,mira}.ts`). | Needs a migration plus a generic, template-driven runner role. This is the largest single change. |
| Per-seller recipients (§7) | **Already modeled.** `approved_service` binds `gateway_identity`, `recipient` and `recipient_ata` per service, and an approved row requires them. The x402 client enforces `payTo` against the binding. | A seller running its own compliant x402 endpoint can already be paid, as one `approved_service` row per seller. This is the cheapest path. |
| Managed sellers via Veilo gateway | The gateway has one merchant address. | Per the handoff's own rule, block managed paid listings until the gateway supports per-listing `payTo`. Don't route seller funds to the operator. |
| Free jobs (Phase 2) | `service_sku` requires `price_usdc > 0` on `private_x402` and `usage_units > 0` on prepaid. | A free path needs a third `payment_path` (e.g. `free`) and a check, or the free path stays outside the purchase ledger. |
| Pool contract changes (§12) | None needed for direct seller settlement. The pool pays a fresh signer, and an ordinary x402 transfer follows. | Confirms the handoff's preferred "additive off-chain" route. |
| Supabase Web3 auth (§3) | Control already has a single-use challenge login, and the handoff says "don't build a second custom auth service". | Two identities are unavoidable, and that's correct: a Supabase marketplace session (cloud) plus the local control owner session (spending). Document it as a deliberate two-boundary design. Don't replace the local login. |
| Supabase holds jobs/quotes/accounting (§5) | Control SQLite is authoritative for reservations and the purchase ledger. | Supabase may mirror quotes and jobs, but `purchase`, reservations and notes stay local. Every cloud payment record is a projection, never a source of authority. |
| Seller earnings from chain receipts (§7) | The relayer indexes pool events only, not arbitrary SPL transfers to seller ATAs. | Needs a new receipt verifier keyed by signature and instruction index. |
| Refunds (§7) | The ledger has a `merchant_refund` reason in token events. There is no refund request/claim flow. | New flow. Its destination must be an owner-verified recovery address, never the fresh payer by default. |
| Controller ↔ cloud channel (§4) | Doesn't exist. Control is loopback only. | Needs an outbound authenticated poll/stream plus signed request envelopes. This is new attack surface and must be designed before any hosted spending. |

## 4. Stress test: weaknesses in the handoff itself

1. **The marketplace as a whole is too big for a hackathon P0.** Phases 1–6 add a hosted multi-tenant service, a second auth system, RLS, Storage, a credential broker, MCP connectors, sandboxed hosted execution, a receipt indexer, refunds and a cloud↔local channel. Any one of these is days of work with security review. Running it in parallel with the unfinished P0 risks both.
2. **Managed hosting means running untrusted seller configuration on operator infrastructure.** The handoff calls for isolation, egress control and metadata-endpoint blocking (§9). Nothing in the repo provides container isolation, because the runner is a local Node process. Phase 2 is underspecified on the sandbox technology, which is the hard part.
3. **Prepaid with no escrow plus seller-funded refunds means buyers carry all delivery risk.** The handoff discloses this honestly. For a demo with test tokens it's acceptable; for anything real it is the main product risk.
4. **Login wallet vs funding privacy.** Supabase Web3 login links the login wallet to the account, and therefore to jobs and sellers. Pool privacy protects deposit → payment linkage on chain, but the marketplace operator sees the buyer → seller relationship anyway. §8 says this, and the UI must say it too.
5. **Supabase is a new hard dependency.** The PRD forbids requiring it. If the owner adopts it, the local-only P0 must keep working without it, or the PRD must change.
6. **Exactly-once across cloud and local.** Each quote/job lives in Postgres while each purchase lives in local SQLite. The binding (operation ID ↔ quote digest) needs an explicit two-phase protocol through outbox/inbox. The handoff names it but leaves the protocol undefined. This is where duplicate-payment bugs will appear.

## 5. Owner decisions needed before Phase 1

1. Is the marketplace a post-P0 track, or does it change the submission scope? If it changes scope, amend `PRD_latest.md` (Supabase, multi-party) so `CLAUDE.md`'s "read the PRD" rule stays consistent.
2. Should Supabase be adopted at all for the first slice? A local-only catalogue (a static JSON of reviewed listings) proves discovery and hiring without it.
3. Hosting model for v1: remote seller endpoints only (recommended), or managed templates too (needs a sandbox plus per-listing gateway `payTo`).
4. Which Supabase project to use, if any. Nothing has been created or migrated.

## 6. Recommended thin slice (after the P0 demo run)

This demonstrates "discover → hire a specialist → seller paid directly → deliverable" with no new authority surface:

1. Generalize agents with a migration to relax the `role`/`kind` CHECKs into `template`. Add a generic runner role driven by template config. Shawn, Prince and Mira become templates.
2. Add a listing catalogue: reviewed seller listings, each mapping to an `approved_service` row with a fixed `recipient`, `recipient_ata` and SKU price. It can be local first; a Supabase projection is optional.
3. Build a demo seller by running a second gateway instance with its own merchant key as an independent "seller endpoint". The buyer's agent proposes, the owner approves the listing, and control/wallet pay it through the existing private x402 path. Seller earnings come from that merchant ATA's finalized receipts.
4. Defer Supabase auth/RLS, managed hosting, MCP connectors, refunds and the cloud↔local channel to later phases, as the handoff itself sequences.

Acceptance for the slice reuses the existing CAP/IDEM/REC tests plus new ones:
- An unapproved listing can't be paid.
- A changed recipient is rejected.
- One receipt yields one earnings event.

## 7. Not verified here

- Tests were not run on this Mac at the time of writing; the `fix/devnet-demo-run` work covers that.
- Supabase Web3 auth behavior, RLS and Storage were not tested; no project is selected.
- x402 facilitator support for arbitrary third-party `payTo` was not checked live. The client-side binding supports it in code.
