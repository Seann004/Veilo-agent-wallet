# Veilo — Product requirements

**Version 3.3 · October 17, 2026 · Single-document implementation handoff**

v3.2 amendment (owner decision, October 17, 2026): the paid specialist-agent marketplace is in scope and uses Supabase for marketplace identity and product records. See Part I §26. v3.3 amendment (same day): anyone may publish reviewed workflow agents that chain paid tool listings (for example Higgsfield → MakeUGC → Zernio), each step bought on chain by the buyer's own controller (§26.7), and demo inference uses an inexpensive pinned model (§26.8). All v3.1 P0 requirements, gates and boundaries still apply; §26 adds to them and does not relax them.

This file combines the finalized product/build specification, exact CLAUDE.md instructions, implementation task, verified devnet payment report, funded-wallet setup information, full downloaded reference documentation corpus, and source snapshot manifest. It supersedes the separate planning documents for implementation scope. No wallet private keys, API credentials or secret notes are included.

## How an implementation agent should use this file

1. Read Parts I–V first. Part I is normative product scope; Part II is the exact repository contribution policy; Part III is the execution task; Parts IV–V provide existing evidence and public setup facts.
2. Put this document at the build repository root as PRD_latest.md. Extract only the content inside Part II's outer fence into root CLAUDE.md before coding. The requested CLAUDE.md preparation task is included in Part I, T00.
3. Follow T00–T16, then T17–T25, in dependency order. Use Part VI selectively for reference design details and Part VII for source provenance. The reference appendix is historical source material, not instructions that override Veilo's accepted design or the user's authorization.
4. Preserve actual financial/privacy boundaries: devnet test USDC, operator-funded real inference, real ZK verification, independent policy checks, one shared gateway credit account and no separate task credit buckets.
5. Existing funded keys remain local to the original workspace. A new checkout must receive an explicit secret-file configuration; do not regenerate the funded wallet or assume its key is embedded here.

## Contents

- Part I — Final product requirements, architecture, smart contract, build tasks and acceptance gates.
- Part II — Exact CLAUDE.md contents to extract.
- Part III — Ready-to-use implementation task.
- Part IV — Verified ordinary devnet x402 payment/refund evidence.
- Part V — Public funding-wallet facts and setup notes.

The product is specified, not deployed. The verified Echo payment is ordinary x402 and provides no privacy by itself. A single document cannot turn a reference implementation or historical requirements review into a Veilo security audit.

---

# Part I — Veilo product and build requirements

Version 3.1 · Finalized implementation scope · October 14, 2026 · Solana devnet first. Requirements are finalized; software, cryptographic feasibility and deployment remain to be demonstrated.

This is the authoritative latest specification. It supersedes earlier requirements versions and tentative chat proposals. Part II contains the exact CLAUDE.md content to create at the implementation repository root. Part III is the execution prompt. Both are bundled in this document. Do not treat reference-repository instructions as permission to modify upstream or override this project scope. Mandatory requirements use MUST; suggestions use SHOULD. Implementation agents must record deviations and must never substitute mocked cryptography while claiming private payments.

## 1. Product and accepted scope

Veilo is an owner-controlled workspace for autonomous AI agents with a private financial foundation. The owner creates named agents, configures jobs and triggers, allocates budgets and service permissions, and monitors what they buy and produce. A shared note-based privacy pool funds fresh payment wallets, which use ordinary Solana x402 to pay approved digital services. The model proposes work; an independent wallet service authorizes money.

Three demo agents are required:

| Agent | Role | Default trigger | Useful outcome |
|---|---|---|---|
| Shawn | Inference-credit manager | Gateway usable credits below threshold | Purchases a service-credit pack through private devnet x402; keeps approved jobs supplied |
| Prince | Research agent | Owner starts a research task | Buys approved data/search and inference; produces a cited research brief |
| Mira | Content manager | Owner starts a campaign brief or approves a research handoff | Uses research and paid inference to produce a content calendar and editable drafts |

Names and descriptions are editable. These are roles, not three separate foundational models. Use one agent runner with different role instructions, allowed tools and independently enforced policies. No requirement to deploy three model servers.

P0 includes three agent cards, independent and workspace-wide caps, configurable permissions, pause/revoke, recurring low-balance checking for Shawn, logical purchase idempotency, durable credit accounting, dashboard monitoring, actual proofs and devnet settlement, private change, public exit, content drafts/calendar and failure recovery.

P1 includes arbitrary schedules, optional risk flags, image generation, broader API catalog, receipt export and optional content approval notifications. P2 includes external social publishing, trading/scalping, physical shopping, arbitrary browser purchasing, production funds, bridges, multi-owner workspaces and proof-enforced private spend policies. Multiple independent accounts acting as buyers and sellers in the marketplace are in scope under §26; each workspace still has one owner. Hard validation and rejection are P0 even though anomaly flagging is optional.

Product promise: create agents that buy approved resources and complete useful jobs within your permissions, with private funding and transparent owner monitoring. “Buy anything” is a future integration vision, not the initial capability.

## 2. Differentiation and Topic F


| Topic F capability in supplied excerpt | Evidence Veilo must produce |
|---|---|
| Autonomous on-chain operations | Shawn purchases after a threshold trigger without another owner approval |
| Asset management | Independent allowances and global exposure accounting across three agents |
| Transaction execution | Real proof-authorized pool withdrawals and standard x402 settlement signatures |
| Risk control | Deterministic caps, recipient bindings, expiry, independent revoke and replay prevention |
| Ambitious implementation | Private funding integrated into a useful multi-agent workspace |

Build on devnet as requested. The supplied checklist requires real on-chain transaction hashes but does not explicitly settle mainnet versus testnet acceptance. Solana/devnet eligibility and reuse rules remain an organizer check; neither bonus points nor winning is guaranteed.

## 3. Demo truth and OpenRouter integration

### 3.1 Required integration

Use an operator-controlled **Veilo Service Gateway**. It exposes conforming x402 V2 routes on Solana devnet and calls OpenRouter's authenticated API using an operator-funded account. The commercial inference provider is OpenRouter; the x402 merchant is the gateway operator. Test tokens do not have monetary value and do not replenish real OpenRouter credits.

Two gateway purchase products are required: fixed-price inference calls and fixed-price prepaid inference-credit packs. Research data is supplied by a second route/service. Prefer a reproducible licensed fixture collection for the first devnet data product, clearly labeled demo data, with optional real search behind a separately funded adapter. At least inference must return real model output in the accepted integrated demo.

Shawn checks **Veilo gateway credits** and tops up those credits through x402. The dashboard MUST label them “Demo inference credits — backed by the operator's OpenRouter account.” Do not label them “OpenRouter account balance.” Reading an operator's actual OpenRouter balance is optional operational monitoring and requires the appropriate credential; it is not the user-credit ledger.

The OpenRouter account, model availability, and dollar balance are operator dependencies. Gateway health checks verify these before a run. If commercial credits are unavailable, pause inference and report the condition. Do not automatically charge a real card or top up a real provider account. A mock provider is permitted in automated tests only; fixture mode is visible and does not pass real-inference demo acceptance.

### 3.2 Inference bootstrap

Shawn's threshold check and top-up decision are deterministic policy execution; they need no paid model call. This avoids requiring credits to obtain more credits. Prince and Mira may use bounded operator-funded planning calls before selecting a purchased service. Count and report these as “operator-sponsored planning,” separate from purchased inference. Defaults: at most two planning calls per task, fixed allowlisted model, maximum configured input/output tokens and provider timeout. No unlimited reasoning loop. All further purchased execution goes through the gateway credit/per-call path.

Planning credential is server-side and inaccessible to agent tools. Paid gateway calls and planning calls have separate real provider quotas. A local/free planner is an optional adapter, not required for the demo.

### 3.2a Seeded demo service catalog

Seed these illustrative SKUs; all amounts are test-token or gateway-credit units. Upstream model IDs are selected from currently available OpenRouter models and pinned by the implementer, not guessed from marketing names. SKU quotas must fit the operator real-cost bound before enablement.

| SKU | Payment path | Fixed demo charge | Bound / delivery |
|---|---|---|---|
| inference-credit-pack | Private pool → fresh wallet → x402 | 1,000,000 test-USDC base units | Issues 1,000,000 gateway microcredits once |
| research-basic | Private pool → fresh wallet → x402 | 100,000 test-USDC base units | Small licensed fixture dataset with source metadata |
| research-expanded | Private pool → fresh wallet → x402 | 200,000 test-USDC base units | Expanded fixture dataset, giving Prince a real selection |
| summarize | Prepaid usage or per-call x402 | 100,000 gateway microcredits OR 100,000 test-USDC base units, never both | At most 8,000 input tokens and 1,000 output tokens |
| analyze | Prepaid usage or per-call x402 | 200,000 gateway microcredits OR 200,000 test-USDC base units, never both | At most 8,000 input tokens and 2,000 output tokens |
| content-package | Direct per-call x402 for the accepted content demo; prepaid is an alternative | 300,000 test-USDC base units OR 300,000 gateway microcredits, never both | At most 8,000 input tokens and 3,000 output tokens; three drafts/calendar |

Token bounds are operator-verified for each selected model using the provider-compatible tokenizer or a conservative enforced input limit; raw character count is not claimed as exact tokens. Reject overlong input rather than silently raising a bound. Exact result format is schema validated, with repair/retry requiring a new permitted attempt if it creates provider cost. These tariffs demonstrate wallet behavior, not sustainable commercial pricing or OpenRouter's own rates.

### 3.2b Required content purchase and network scope

Mira MUST demonstrate a direct content-package purchase with test USDC from the private pool through a fresh signer and standard devnet x402, then receive real operator-funded inference and save drafts/calendar. No separate user service-credit balance is required for this path. Existing shared gateway credits remain for Shawn's replenishment example and Prince's permitted prepaid inference. UI and ledger explicitly indicate which path a purchase uses; direct USDC purchase never also consumes prepaid units.

Credits are a service prepayment option, not a replacement pool asset and not part of ZK ownership. The pool continues holding test USDC. Exact per-call x402 is valid without a credit ledger. Do not force every agent onto prepaid mode merely because Shawn demonstrates replenishment.

The default devnet merchant is our own gateway, configured for exact devnet payment and backed by the operator's real inference account. Commercial OpenRouter and third-party mainnet gateways are not assumed to accept test SOL/USDC. Validate an external sandbox's supported network/mint explicitly before use; no live public commercial devnet endpoint is required for the demo. Label operator-funded inference and test settlement accurately.

### 3.3 Gateway credits

Credit units are application entitlements, not OpenRouter credits or redeemable money. Use integer microcredit units; demo pricing may map a 1.00 test-USDC pack to 1,000,000 microcredits, explicitly as a configured demonstration rate. Fixed model SKUs consume fixed quoted units under strict input/output limits. Do not promise unlimited model output or convert unknown token usage to an uncapped bill.

Wallet expenditure happens when Shawn purchases a pack. Prince/Mira consuming that pack reduces gateway credits and their **usage allowances**, not USDC expenditure a second time. The dashboard distinguishes cash spent, prepaid credits available/reserved/consumed, per-agent usage, and sponsored provider costs. Report purchase cost attribution to Shawn and consumption attribution to Prince/Mira. UI never sums those as two payments.

The gateway links its persistent credit account and authenticated requests off chain. This is an explicit tradeoff: private funding removes the explicit deposit-to-payment mapping but does not hide usage from the gateway or OpenRouter. Account IDs and agent names MUST NOT enter chain memos, proof public inputs or withdrawal accounts.

## 4. Build stack and project layout

Default to a local owner-operated single-user deployment. Use TypeScript, Next.js for the dashboard, Express for gateway/service endpoints, a durable job worker and policy service, SQLite in WAL mode for demo persistence, Rust/Anchor for the pool program, Circom/snarkjs BN254 for proofs, and @solana/kit plus pinned x402 V2 SDK packages. Use the SDK family actually supported together at implementation time; record exact versions in the lockfile. Do not mix incompatible transaction/signing libraries without adapter tests.

Proposed monorepo:

```
apps/dashboard/          owner UI and authenticated control API
services/control/        policies, signed owner actions, scheduler and atomic ledger
services/runner/         restricted role workers and LLM planning
services/wallet/         private notes, proofs, constrained signing and recovery
services/gateway/        x402 routes, durable credits, OpenRouter/data adapters
services/relayer/        withdrawal submission, fee sponsorship and public indexer
packages/contracts/      API schemas, errors, shared integer types
packages/db/             migrations and repository interfaces
packages/x402-client/    quote verification and fresh-wallet signer adapter
packages/privacy-sdk/    notes, encodings, witnesses, proof artifact manifests
programs/privacy-pool/   Anchor/Rust program and ledger invariants
circuits/                spend, authenticated insert, owner public exit
tests/                   adversarial, integration and restart tests
scripts/                 setup, seed, deploy, smoke, demo and evidence export
artifacts/               generated verifying-key manifests; no production secrets
```

Do not require social credentials, mainnet keys or a third-party privacy service. The P0 local owner stack (T00–T16) MUST keep running without Supabase. Supabase is required only for the §26 marketplace, and only as an application identity and product-record store, never as a wallet vault or spending authority. A local service is still a trusted boundary: enforce separate processes/credentials/filesystem permissions. The agent runner MUST NOT read the database holding encrypted notes, decryption secrets, provider credentials or signer endpoints granting arbitrary signatures.

In a public demo, dashboard access is authenticated and the signer remains local/private. No anonymous deployment with funding, policy or gateway administration endpoints exposed.

## 5. User flows and screens

### 5.1 Workspace setup

Owner connects Phantom or another compatible wallet, signs a nonce-based session challenge, sees a persistent devnet badge and confirmed network/mint, and initializes the local wallet-service secret backup. The app never requests the owner's seed phrase. Deposit requires a normal wallet signature. An owner session alone cannot manufacture a signature on an on-chain exit requiring the original refund key.

Show separate deposit states: submitted, finalized, indexed, approved, spendable. An unapproved note is not counted as available. The dashboard includes pool membership information and an explicit privacy explanation.

### 5.2 Create/configure agents

“Create agent” selects a role template, name, job, trigger and model profile. The owner reviews structured policy before activation. Natural-language policy editing produces a draft only. Spawn means create an agent record and constrained worker instance; it does not create a new autonomous authority that can spawn further spending agents.

Each card shows role, active/paused/stopped state, allowance, pending spend, recent task, credit usage and last result. Owner can configure, run, pause, revoke or archive. Archived agents cannot schedule new work but retain records.

### 5.3 Shawn

Monitor gateway available credits every 60 seconds by default; demo can use an explicit “Check now” action that executes the same logic. Example policy: threshold 200,000 units, pack size 1,000,000 units, maximum purchase 1.00 test-USDC, rolling 24-hour cap 3.00 test-USDC, 10-minute minimum interval between successful top-ups, one outstanding top-up per account. Values are editable within configured limits.

Read balance with freshness/version data. Stale/unavailable balance pauses the check. If balance is below threshold and no unresolved top-up exists, create one purchase intent, validate policy and buy one pack. Record the triggering balance/version. Duplicate scheduler checks reuse the outstanding operation. Re-evaluate after confirmed credit issuance; don't loop indefinitely if demand drains credits immediately. All checks respect cooldown, per-agent and workspace caps. The model may explain the action but cannot override these rules.

### 5.4 Prince

Owner supplies research question, optional sources and deadline. Prince proposes a plan, compares approved fixed-price data services and chooses at least one relevant purchase. It requests inference using its usage allowance or makes a separate per-call x402 purchase if policy permits. Output is a research brief with retrieved evidence links and paid-service references; incomplete claims are marked. No fabricated source citations. Demo fixtures are labeled in the output.

### 5.5 Mira

Owner supplies topic, audience, channels, voice, deliverables and deadline. Mira optionally receives an owner-approved Prince output, chooses an approved inference SKU and directly purchases content-package through private devnet x402 for the integrated demo, drafts three channel-specific posts and a seven-day calendar, and saves editable versions. Track draft, needs review, approved for export and archived states. Editing or approving a draft does not trigger new paid inference. Regeneration is a distinct task/action with a new budget check and operation ID.

“Schedule” in P0 means a content planning date, not an external publishing promise. No social account connection, posting or messaging in P0. Do not automatically publish after approving a draft. An approved handoff allows local data transfer and reserves Mira's task allowance; it does not let Prince change Mira's policy or silently trigger paid work. No role-to-role spending delegation chains.

### 5.6 Monitor/recover

Overview shows global limits, agent limits, task limits, cash spent, cash reserved, credits purchased/consumed, pool funds and recoverable funds. Activity exposes rationale, policy result, merchant, price, fees, funding signature, settlement signature, result state and recovery status. Expandable transaction links use devnet explorers.

Pause/revoke stops new authority for one agent; global emergency stop stops all new authority. Pending transactions remain visible. Recovery and public exit are owner-only flows, with privacy-impact warnings.

## 6. Policy model and financial invariants

### 6.1 Required scopes

P0 MUST enforce per-purchase hard limit, per-task lifetime budget, per-agent lifetime allocation and rolling 24-hour spending cap, workspace lifetime allocation and rolling 24-hour spending cap, and a separate SOL sponsor/rent allowance. Content and research also have gateway usage caps. Every purchase satisfies all applicable scopes.

Lifetime limits count unrecovered expenditure plus live exposure. Rolling caps count settled costs during the preceding 24 hours plus all live reservations, including old unresolved attempts. A stale reservation cannot escape the cap just by crossing the time window. Long-lived allocation commitments and currently incurred costs are separate fields.

All token amounts are integer base-unit decimal strings over APIs and checked integers in code. Never use floating-point comparisons. USDC has configured mint decimals verified at startup. Sponsor lamports and test-USDC costs are distinct. A fiat-equivalent unified cap is out of scope.

### 6.2 Atomic authorization

A single SQLite transaction locks/rechecks workspace, agent, task and note availability, creates a reservation and a unique purchase operation, and records the policy version. SQLite BEGIN IMMEDIATE plus uniqueness constraints is sufficient for the single-host demo; all writers MUST use the same control service, not independent databases. Lease-based jobs use compare-and-set transitions. Limit note spending to one outstanding operation per note; jobs can queue safely even though agents are concurrently active.

For each scope: `available = limit - settled_cost - active_reservations`. Proposed reservation is merchant price plus capped known USDC fees. Sponsor lamports are reserved separately. After settlement, replace reservation with actual costs; recovery restores only recovered principal and unused cost reservation. Never restore paid merchant fees or service cost merely because the result was poor.

For credits: `usable = issued - consumed - reserved`. Reserve the SKU's full fixed charge before upstream inference, deduct once on success, and release/refund according to the gateway's explicit failure rule. An ambiguous upstream outcome is not blindly retried.

### 6.2a Physical token states and immutable timestamps

The physical token ledger tracks approved/unreserved notes, reserved input notes, consumed notes, pending change insertion, confirmed spendable change, funded payout balances, merchant outflows and external recovered balances separately. Finalized withdrawal consumes the entire input note exactly once. Only its remainder becomes pending change; pending change is unavailable until authenticated insertion is finalized and a witness is rebuilt. Payout balances are no longer pool-note assets. Do not add policy allowance, physical token value and service credits into a single balance.

Withdrawal debit equals merchant funding plus authorized token fees, and input value equals debit plus change. Funded-but-unpaid principal remains reserved exposure. External recovery restores eligible policy allowance but does not create a pool note: returning it to private spending requires a new deposit. Persist recovery/refund as a linked adjustment; never manufacture negative expense or erase already paid fees.

Set settled-cost timestamp once using service-observed finalized settlement time; do not rewrite it on restart. For rolling caps, refunds adjust the linked expense only while that original expense remains in the window; expired original expenses are not offset against unrelated new spending. Lifetime allowances may restore proven recovered principal regardless of window. Unresolved reservations always count.

### 6.3 Authority and tiers

Observe: plan only. Bounded automatic: authorizations satisfying every policy proceed. Approval required: some otherwise-valid purchases need explicit owner approval. Stopped: reconcile only. No tier overrides hard caps. Owner policy expansion is a separate authenticated action.

Allowed service binding includes origin, gateway identity, product SKU, exact network/mint and recipient/ATA derivation. Redirects and new recipients require a new approved binding. Validate every merchant instruction before signing, including compute budgets, transfer authority and fee payer, using conforming x402 SDK checks plus Veilo's scope checks. Unknown transfers, approvals, delegate changes and unrelated instructions are rejected.

### 6.4 Revocation race

Persist policy version and revocation epoch. Recheck before releasing a proof, before withdrawal submission, and before signing the merchant leg. Maintain a local serialized authorization boundary so pause and signature release have an unambiguous order. No promise to cancel proof/transaction material already released. A proof already delivered to the relayer may settle until its on-chain expiry; record it as live exposure. A funded fresh wallet whose merchant leg is stopped becomes recoverable after conflicting signatures expire or settle. Global stop does not disable recovery/public exit.

## 7. Privacy protocol requirements

### 7.1 Invariants, not a copy-and-rename

The reference runs Cardano-specific validators and BLS12-381 proofs. Veilo's default proof path is BN254 Groth16 with matching Poseidon parameters and canonical encodings throughout TypeScript, circuits and Rust. Verification/proving keys from Cardano are unusable for this deployment. Circuit changes require new artifacts and explicit deployment compatibility handling.

The accepted private path MUST contain a real on-chain proof verifier. No trusted database withdrawal authorizer, skipped verifier, single-party signature pool or cosmetic address rotation can substitute for it.

### 7.2 Note and pool design

Default note model: `commitment = Poseidon(value, label, Poseidon(nullifier_secret, note_secret))`. Value and remainder are unsigned 64-bit amounts. Label binds pool and original deposit/refund authority through a specified domain-separated canonical encoding. Deposit amount, source and timing are public. Label may be public at deposit but is private in subsequent spend witnesses.

Spend proof demonstrates commitment membership, approved label membership, nonzero label, correctly derived nullifier, withdrawal not exceeding note value, range-checked remainder, change commitment retaining the label, fresh change secrets and bound intent. Public spend fields: pool-bound context, tree root, approved root, nullifier hash, withdrawn value and new commitment. The program rejects out-of-field encodings and repeated nullifiers.

Intent MUST bind deployed program/pool, devnet identity, exact mint, destination token account/owner, payout and fee amounts, selected relayer when applicable, and expiry. Hash bytes and field conversion rules are deterministic, range-checked and covered by shared vectors. Do not expose task/agent/account identifiers in intent public fields.

Pool vault is a PDA-controlled SPL token account. Initialize expected mint, authorities, empty roots and configuration on chain. Deposits produce immutable pending insertion records derived from actual successful token transfer. Reject duplicate precommitments. Only authenticated tree transitions may update root state: use an insert circuit whose public leaf inputs derive from pending deposit/change records. Start with one queued leaf per insert for the prototype, measured bounded depth and a documented capacity. Use depth 16 initially; measure before freezing artifacts. A resource-limit failure requires a documented protocol revision, never a mocked verifier. Do not accept arbitrary indexer-supplied roots.

Spend marks nullifier used, subtracts checked total withdrawal, transfers the exact authorized payout/fees and enqueues change atomically. No partial program state may persist on an instruction failure. Maintain root history with explicit bounds so honest recent proofs have a chance to settle. Indexer rebuilds public state and compares on-chain roots. Approved-set updates authenticate the operator; publish prototype approval rules. Claims of sanctions screening are prohibited without a real connected screening source.

Owner exit uses a proof of note ownership/membership and a matching original refund signature, reveals the required note value/label, consumes its nullifier and pays the refund owner. It MUST not require approved-set membership or an operator's discretionary permission. Supporting owner exit with both an original note and a change note is P0. Define refund-authority binding and instruction vectors before writing the program.

Program upgrade authority and approved-root authority are separate and disclosed. Upgradeable demo programs add trust; do not say the operator cannot ever change code. Use test funds only. Do not destroy note artifacts or deploy new keys over a live compatible pool without a migration/exit plan.

### 7.2a Exact refund-authority and expiry binding

Use a unique 32-byte deposit salt and a canonical label: integer big-endian interpretation of the first 31 bytes of SHA-256 over the UTF-8 domain veilo/label/v1 followed by fixed-width pool public key (32 bytes), mint public key (32 bytes), refund public key (32 bytes), and salt (32 bytes), in that order. A 31-byte output is below the BN254 scalar modulus. The deposit program derives this label from the original refund signer and stores the salt/binding. Original and change note backup retains the salt. This is Veilo's chosen initial protocol encoding; freeze and verify it with vectors in M2. It is not a reference-project artifact.

Public exit requires the exact refund authority as signer and pays only its exact-mint ATA. The program reconstructs the label from that signer, pool, mint and disclosed salt and feeds the derived label as a public input to the exit verifier. The exit circuit proves note membership containing that exact public label and the derived nullifier; it cannot choose another private label. Thus a valid arbitrary note proof plus an attacker signature is insufficient. Program computation of the public label provides the cryptographic binding; no Ed25519 verification inside the circuit is required. Spend and exit use the same pool-scoped nullifier, so either consumes the note exactly once.

Withdrawal intent uses valid_until_slot, distinct from transaction last-valid block height and HTTP quote expiry. Program reconstructs the context from the full instruction intent and rejects when Clock.slot exceeds valid_until_slot. A relayer cannot extend the bound by putting an old proof into a new-blockhash transaction. Released proof remains exposure until finalized chain evidence is beyond its bound, its nullifier is confirmed unused and no settled withdrawal exists. Transaction blockhash expiry alone cannot free a reusable proof reservation. Modification of the bound invalidates context verification.

### 7.2b Program and artifact contract before deployment

Default token program is the original SPL Token program, excluding Token-2022 extensions in P0. Pin this in the deployment manifest and reject another token program, delegate or unexpected vault authority. Native SOL is sponsorship only, not a merchant payment asset.

Required program instructions: initialize_pool, deposit, refund_pending_deposit, insert_leaf, update_approved_root, spend_private, exit_public and the documented constrained configuration controls. Pending-deposit refund requires original owner signature, cancels exactly its pending queue record, returns its recorded amount and cannot race insertion successfully twice. A committed inserted deposit exits with a real owner-exit proof. Queue transitions include canceled records deterministically so refunds cannot corrupt an authenticated insertion proof.

Instruction contracts and account lists must be frozen in a protocol-spec file before circuit setup. Exact types and canonical encodings for labels, contexts, fees, owner exit and field elements are part of that file. Spend and exit share the same pool-scoped nullifier namespace. Nullifier-account creation is deterministic from the pool and canonical hash; an existing initialized account rejects reuse. Neither an account hash alias nor leading-zero alternate encoding may bypass replay detection. Runtime integers use checked arithmetic, and every public circuit field is less than the selected scalar modulus.

Default root history keeps the newest 32 authenticated commitment roots, approved-set depth matches configured label-tree depth, and issued withdrawal intent uses valid_until_slot at most 750 slots beyond the observed finalized slot, checked against the on-chain Clock slot. This is a slot bound, not a promised number of seconds. Only the current approved root authorizes private spending. Exit does not require that root. Tree depth and root history are measured defaults, explicitly finalized in M2 before artifact generation; capacity exhaustion rejects new deposits safely rather than overwriting tree slots.

Deployment manifest records exact genesis hash/CAIP network, program/pool/vault addresses, mint and decimals/token program, circuit source hash, compiler flags, curve/scalar field, hash parameters, tree depths, public-input order, encoding/vector version, proving/verification key hashes, setup provenance, fees/bounds, authority keys and root-history rules. Proving files are content-addressed and verified before use. Test one known proof through TypeScript verification and the deployed Rust verifier. A manifest mismatch stops proof/payment generation rather than downloading arbitrary replacements.

A sponsor pays ATA creation/rent and transaction fees within separate caps. Gross outstanding recoverable rent exposure must have its own counter; refunded rent is not negative fee expense. Sponsor-funded temporary ATA closure sends recovered rent to the configured sponsor, not a worker-supplied address. Close only a zero-token account using its real close authority after signatures are reconciled. Owner recovery of remaining token principal and closure/rent recovery are distinct ledger events.

### 7.2c Concrete devnet program account and instruction specification

The pool is a custom Anchor/Rust program with SPL Token CPIs, not an externally controlled wallet holding pooled deposits. A PDA authority signs vault transfers through invoke_signed; no vault private key exists. The setup wallet does not itself enforce note ownership and must never be presented as the live pool. Program and vault addresses are unknown until implementation/deployment and go into the deployment manifest; do not invent them now.

Minimum accounts and derivations (final canonical seeds frozen in protocol vectors):

| Account | Default PDA seeds / relationship | Required content and ownership |
|---|---|---|
| PoolState | pool, 32-byte pool instance ID | Program-owned state: immutable mint/token program, vault authority, commitment root/history, leaf count, queue pointers, config/approval authorities and circuit version |
| VaultAuthority | vault_authority, PoolState key | Program PDA, no private key; sole authority permitted to move pool tokens |
| TokenVault | Original SPL Token ATA of VaultAuthority and pinned mint | Exact mint/owner, no external delegate; controlled transfers only through verified program instructions |
| PendingDeposit | deposit, PoolState key, little-endian u64 deposit sequence | Value, derived label, precommitment, salt/refund authority, pending/inserted/refunded state; actual received amount |
| SeenPrecommitment | precommitment, PoolState key, canonical 32-byte precommitment | Permanent duplicate prevention for that pool, independent of SDK |
| PendingChange | change, PoolState key, nullifier hash | Proof-produced commitment and insertion state; no plaintext value/owner/agent ID |
| SpentNullifier | nullifier, PoolState key, canonical 32-byte hash | Permanent spent marker shared by spend and exit; never closed for rent reclamation |
| RootHistory / Queue | Embedded bounded state or measured program-owned pages | Authenticated roots and exact next-leaf queue transitions; no arbitrary user-controlled replacement |
| ApprovalState | approval, PoolState key | Current approved root, version and update authority; no withdrawal signing powers |
| VerificationKeys | Fixed in deployed binary or immutable program-controlled artifact accounts | Matching BN254 circuit versions; no user-supplied verification key |

Program MUST verify canonical PDA bumps, account ownership, exact mint/token program and cross-account pool identity for every instruction. A correctly shaped account for another pool is not accepted. User task/agent IDs never appear in PDA seeds or public events. Salt and deposit sequence are protocol identifiers, not private workspace identity.

| Instruction | Signer/authorization | Required checks and effects |
|---|---|---|
| initialize_pool | Demo deploy/config authority | Pin mint/token program, keys and empty-root values; create correct vault authority; reject repeated initialization |
| deposit | Actual refund owner and funded source authority | Positive bounded amount, correct source/vault, no fee-on-transfer extensions, derive owner-bound label, create unique precommit marker; transfer and record pending deposit atomically |
| refund_pending_deposit | Original refund signer | Only still-pending deposit; cancel/tombstone queue item and transfer recorded principal to owner's exact-mint ATA once |
| insert_leaf | Any funded submitter with valid insert proof | Next queue item only, derived public leaf inputs, allowed old root/index, valid new root; record finalized insertion exactly once |
| update_approved_root | Declared approval authority | Only approval state/root version changes; no arbitrary vault transfer or note-tree root update |
| spend_private | Relayer if intent names one, otherwise funded submitter; actual ZK proof | Allowed commitment root, current approved root, canonical/range inputs, intent-bound mint/payout/fees/slot bound; consume nullifier, transfer exact debit, enqueue change atomically |
| exit_public | Proof plus bound original refund signer | Allowed state root and owner-derived public label, same nullifier space, mint/ATA matching; consume note and transfer note value without approval membership |
| update_config | Config authority | Only bounded permitted caps/fees/deposit-pause fields; cannot change mint, keys, tree roots, rewrite nullifiers, confiscate balances or disable exit |

Prototype defaults: token fees zero unless an explicit quoted nonzero fee is enabled, positive minimum deposit 100,000 base units, maximum deposit 20,000,000, aggregate outstanding pool-liability cap 100,000,000, root history 32. These are test caps, not evidence of production-safe limits. Pending deposits count toward the pool cap. Track aggregate liability using checked actual deposits minus proof-authorized/refund outflows; verify the token vault covers it. Unsolicited direct token transfers are surplus, not spendable notes or permission to insert unbacked commitments. Configure queue capacity and account allocation after M2 measurement; all over-capacity paths reject without losing deposited funds. No privileged sweep or admin_withdraw instruction is allowed. Deployer upgrade authority remains an explicitly disclosed risk unless intentionally revoked after tested deployment; instruction restrictions alone do not neutralize upgrades.

Events report public protocol transitions, amounts, roots, commitments and nullifiers only; no secrets, task content or business account identifiers. The indexer replays events and verifies state against finalized accounts. Rejected/rolled-back transactions cannot create client spendable notes. Program tests cover substituted accounts, vault delegate, cross-pool inputs, exit/refund races, insertion order, atomic transfer failures and account-size/compute limits.

### 7.3 Fresh payment wallets and SOL

One fresh Ed25519 signer per purchase; persist seed/counter or secure random key material before funding. Create its exact-mint ATA through the relayer sponsor, then fund it through proof-authorized pool withdrawal. ATA creation, rent and cleanup are separate from the exact x402 transfer instruction layout. Precreate merchant ATA during setup. The facilitator pays permitted merchant transaction fees. A sponsor may create accounts, but never receives note secrets.

Recovery destination is the preconfigured owner recovery account or an explicitly confirmed owner destination; arbitrary agent-supplied recovery addresses are forbidden. Recovery is publicly linkable and does not restore original privacy. Pending signed transfers must be resolved before moving funds.

### 7.4 Honest privacy boundaries

Hidden property: explicit note/deposit identity behind a withdrawal. Public: deposits, payouts, amounts, mint, merchant, fresh wallet, fees and timing. Pool participation counts are not a measured anonymity score. A one-participant or distinctive-amount pool has weak effective privacy. Approved-set membership size is not proof of many independent active users.

Gateway credit account, prompts, usage and connection metadata are visible to the gateway. OpenRouter sees the operator account and forwarded prompts/model metadata; internal workspace/account IDs are not forwarded by default. RPC access can correlate the path. Use no owner-funded withdrawal fees, no public agent identifiers, minimal operator logs and owner-local detailed history. Warn on small approved sets and matching recent amounts; no proof of metadata anonymity is claimed. Public exit may reveal aggregate spending by subtraction. Demo test participants are identified as synthetic/test participants.

## 8. Concrete x402 payment and service contract

### 8.1 Network and SDK defaults

Use x402 V2 `exact`, devnet CAIP-2 `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`, and the documented devnet USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. Verify mint owner/decimals and full devnet genesis hash using authoritative RPC before initialization. Reject mainnet genesis and mainnet CAIP-2 everywhere in demo mode. If the devnet USDC faucet is unavailable, setup may configure a dedicated six-decimal demo mint for local/devnet testing with explicit labeling and matching facilitator support; never call it official USDC. That deviation is visible in evidence and configuration.

Packages: @x402/core, @x402/express, @x402/svm, @x402/fetch with a tested compatible @solana/kit release. Use protocol object encoders, not hand-crafted header JSON. Headers are PAYMENT-REQUIRED, PAYMENT-SIGNATURE and PAYMENT-RESPONSE. The fresh payment wallet is the token transfer authority; the allowed facilitator sponsor is the transaction fee payer. The fresh payment wallet is the ordinary SVM payment signer; the privacy withdrawal is a separate transaction, not an extra instruction hidden in the standard merchant payment.

Use the live-tested PayAI facilitator https://facilitator.payai.network for the devnet merchant leg by default, subject to current capabilities/terms and complete policy validation. The wallet-service relayer still submits Veilo private withdrawals; it is a different role. Keep Solana Foundation Kora's self-hosted conforming devnet facilitator as the documented fallback. Do not assume changing FACILITATOR_URL alone makes an incompatible SDK/payment form work. Its `/supported` MUST advertise exact support for this network and selected mint path before the gateway announces acceptance. Use the SDK's complete verify/settle implementation, including instruction layout, mint, amount, recipient ATA, transfer authority, fee payer, compute budgets, expiry and replay. Verification/simulation alone is not settlement. SDK APIs may change: build an adapter, pin versions and prove a standard nonprivate payment in the first milestone.

### 8.1a Verified payment baseline — October 14, 2026

A real x402 V2 exact payment was executed using the funded setup wallet against https://x402.payai.network/api/solana-devnet/paid-content. It transferred 10,000 base units (0.01 devnet USDC) using the pinned mint, returned HTTP 200 and protected content, and was refunded in full by the Echo Merchant. Both transferChecked transactions were independently verified finalized with no errors through devnet RPC.

Payment signature: 5Br4iPZQWqnc4WxxFDSbnTxkNaDYgcxax3T8VHo6FF8YzryiEZ9zXMEvSzWVmM4zScGjCSa37qKtYHY2BtQDuNvB. Refund signature: W8WnBPng78B8FXswy3TfRryEBwTykqihB1SuDzGCsya95XFooST3nJVYuadGvKEQbMxXGz1TeyaTeeqwts6B9EU. Tested package versions: {"@x402/core": "2.28.0", "@x402/fetch": "2.28.0", "@x402/svm": "2.28.0", "@solana/kit": "5.5.1"}. Reproduce with a fresh explicit smoke-test operation; never blindly rerun an uncertain paid attempt.

This baseline proves the ordinary merchant payment leg, not Veilo ZK privacy, gateway inference, or complete idempotency. The setup wallet paid directly, so its address is public. Implement the private pool/fresh-wallet leg before claiming privacy. Echo is the integration smoke merchant; our content gateway will provide real bounded inference backed by the operator's funded account. PayAI settles the gateway's advertised devnet USDC price. No mainnet move is required for this demo architecture.

Alternative facilitator https://facilitator.x402.rs advertised V2 exact devnet capability but was not settlement-tested. https://x402.org/facilitator/supported returned HTTP 403 during checks; it is not a verified fallback. Startup rechecks actual support; provider availability is not guaranteed indefinitely.

### 8.2 Immutable quotes and idempotent gateway execution

Owner control issues a logical operation ID and request digest before requesting a quote. Gateway creates an immutable quote: opaque quote ID, product SKU, request digest, authorized gateway account, fixed charge, usage limits, expiry, recipient binding and delivery contract. Quote/account identifiers stay in HTTPS/application data, not on-chain memos.

Payment-gated route is `/v1/purchases/:quoteId/execute`, with authenticated account/operation context and the immutable input digest. A quote is single-purchase; the same quote/operation with changed input returns 409. Do not assume x402 automatically binds arbitrary request bodies; the gateway independently enforces this binding before fulfilment.

Before issuing another payment challenge, the gateway checks its durable purchase record. For an authenticated paid existing purchase it returns stored status/result without invoking settlement or provider again. This bypasses another payment challenge only for that exact authorized purchase; it does not unlock arbitrary unpaid routes. A cached result is not retrievable by transaction signature alone.

A unique signature-to-purchase constraint prevents reusing one settlement for a different quote/account. Settlement outcome is checked against the expected immutable requirement. Store payment signature and confirmed state before authorizing service delivery. Job claims are leased and single-worker. If submission response is lost, reconcile that transaction instead of preparing another debit. Do not sign a new blockhash attempt until the previous attempt is proven no longer settleable and not settled.

### 8.2a Required gateway ordering and re-quote behavior

1. Authenticate caller, resolve stable operation, and compare account/request digest. Quote creation is idempotent by that authenticated operation and digest; changed payload conflicts before any payment work.
2. Return existing paid/delivered status/result even if its quote has expired. Pending/uncertain settlement or provider execution returns/reconciles existing state without another challenge. A record is not reset by quote expiry.
3. Only a truly unpaid operation without live authority can receive a new immutable challenge. Validate complete supplied payment first, then atomically claim its signature and operation before invoking facilitator settlement. Concurrent retries reuse the claim; another quote/account cannot claim it. Signature extraction alone is not payment validation.
4. Reconcile to required finality and atomically emit the single payment event. Credit issuance or provider authorization consumes that event once. Leases cannot start a second provider attempt after an ambiguous first attempt.
5. Re-quote only after confirming no settlement and no live authorization. Preserve logical operation and all prior attempts, recheck price/policy and reservations, and use or safely recover existing fresh-wallet funding rather than automatically withdrawing again.

Honor the immutable accepted price when a payload was accepted while the quote was valid and settles afterward. Reject new payloads submitted after quote expiry. Quote deadline, proof deadline and transaction validity have independent roles. SDK middleware must integrate durable state lookup before emitting 402, including pending records; its default auto-pay retry must not authorize a new purchase on its own.

### 8.3 Provider execution

Model adapters enforce allowlisted model IDs, maximum prompt size, maximum output tokens, timeout, request count and bounded provider cost. Operator config defines per-SKU limits and fixed credit price. If current provider prices/limits cannot be bounded, disable the SKU. No provider auto-fallback that changes price above the reserved bound.

Persist execution-start before sending the upstream request and result before acknowledging fulfilment. If upstream outcome is ambiguous, mark uncertain/paid-without-result and do not blindly invoke inference again. A lost final reply can return the stored result on retry. No guarantee of exactly-once external inference is possible without upstream idempotency; at most one automatic attempt is the safe prototype default.

For prepaid usage, credit authorization reserves units and emits a signed, short-lived, single-use request authorization bound to quote/request digest. The signing credential lives in the wallet/control service, not the LLM. Revocation prevents new usage permits; already issued permits expire and may be honored. Gateway performs atomic debit/reservation and tracks nonce reuse. Balance/read endpoints require authentication. No unguessable identifier alone is considered authentication.

For a credit pack, issue units only after required devnet settlement, once per purchase/signature. Storage MUST be durable; do not copy an in-memory credit-balance design. If restart occurs after settlement but before issuance, reconciliation completes issuance once. Issue no test credits from a failed/expired transaction.

### 8.4 Account scope and cross-service usage reservations

P0 has one authenticated persistent gateway credit account per workspace. Shawn replenishes it; Prince/Mira consume through owner control. Workers cannot supply or change the target account. Persistent account linkability at the gateway is deliberately accepted and shown to the user. Separate task credit buckets were considered and rejected by the owner; do not implement them for this submission.

Gateway ledger alone owns issued/reserved/consumed account-credit counters. Owner control alone owns per-agent/task usage allowances. Control first reserves scoped usage and persists an operation; gateway then reserves account credits idempotently for that same operation. Do not deduct the same gateway credit balance twice. Match account, SKU, units, request digest, operation, opaque authority scope, nonce and permit expiry. Carry one reservation ID across reserve/execute/commit/release. Agents have no direct gateway credential.

A proven pre-dispatch failure releases reservations through idempotent linked events. Successful service consumes the fixed SKU units once. Ambiguous dispatch retains unresolved units and allowance until reconciliation. Failure between databases uses durable outbox/inbox and queries the existing operation; it never creates another permit/payment to guess the outcome. Per-call x402 purchases do not also debit prepaid credits. Gateway can see permitted usage/account attribution but no stable authority identifier is emitted on chain.

## 9. Scheduler, multi-agent coordination and recovery

Single durable scheduler enqueues jobs with unique trigger identities, scheduled timestamp and agent policy epoch. Workers claim jobs with leases and heartbeat; expired leases allow reconciliation, not blind recreation of financial operations. Low-balance jobs maintain one outstanding top-up per target account plus a monotonic replenishment sequence. Shawn updates sequence only through a durable completed/terminal attempt transition.

Research/content runs have bounded tool calls (default eight), paid purchases (default three), duration (default 10 minutes), planning calls and outputs. No agent may create spending subagents, alter policy, approve drafts for the owner, send external messages or use unrestricted HTTP. Tool HTTP fetches are restricted to approved origins and safe URL resolution; reject arbitrary internal/private network targets except explicitly configured local demo services.

Represent payment state using separate funding, merchant, fulfilment and recovery fields. Required transitions include proposed, awaiting approval, reserved, proof prepared/released, funding submitted/finalized, merchant signed/submitted/finalized, delivered, uncertain, paid-without-result, recoverable, recovered and rejected. Never collapse an unknown outcome into failure.

Default settlement gating is finalized devnet confirmation before irreversible credit issuance or service fulfilment, configurable only as an explicit test deviation. Persist blockhash, last-valid height and signatures. Reservation release requires proof no authorization remains settleable and no transaction settled, not elapsed wall time alone. Startup reconciles chain state before starting new jobs.

An encrypted backup includes note secrets, change values/labels, commitment paths or reproducible synchronization data, fresh wallet keys/counters and pending operation metadata. SQLite WAL checkpoint/consistent snapshot must be used for backup. Restore MUST not reuse one-time addresses or authorize another unsettled purchase. Owner seed alone is not promised to recover every change note.

## 10. Data model and schemas

IDs are opaque local UUIDs. API timestamps are UTC ISO-8601; UI uses owner timezone, default Asia/Kuala_Lumpur. Financial numeric fields are decimal strings with currency/unit annotation. Agent names remain mutable display fields, not authority identities.

| Entity | Mandatory fields/constraints |
|---|---|
| Workspace | owner public key, network, mint, global policy/version, emergency stop epoch |
| Agent | workspace ID, name, role, status, policy/version, trigger, target account ID |
| Task | agent ID, objective, limit, deadline, tool/purchase counters, plan, state |
| ApprovedService | origin, gateway identity, recipient, mint/network, SKUs and price bounds |
| Policy | lifetime/task/per-purchase/rolling limits, usage allowance, permissions, expiry |
| Job | unique trigger key, lease owner/expiry, attempt count, agent epoch |
| Purchase | operation ID unique per workspace, digest, immutable quote, agent/task, policy snapshot |
| Reservation | purchase unique, reserved USDC/lamports, status, released/settled reason |
| Note | encrypted secrets, label/value, commitment, state, reserved purchase unique |
| ChainAttempt | purchase/leg, signature unique, blockhash/valid height, observed commitment |
| GatewayAccount | authenticated subject, issued/consumed/reserved units, version |
| CreditIssuance | purchase/signature unique, pack SKU, units, status |
| Usage | operation/digest/nonce unique, account/agent/task, units, provider outcome |
| Artifact | task ID, type, content revision, citations, source purchase references, review state |
| AuditEvent | scope, actor, action, policy result, timestamp; never raw secret values |

Migration scripts create all uniqueness and foreign-key constraints. Append immutable financial events and derive balances from persisted ledger transitions; cached counters must be reconciled. Separate secrets database/files from activity accessible to runner. Use authenticated owner API and scoped worker credentials. Gateway retains only needed prompt/result data for demo result recovery; disclose retention and provide an owner-controlled cleanup after outstanding operations are resolved.

## 11. API and tool contracts

All mutate endpoints validate shared schemas, actor scope, owner/worker authority and idempotency. Browser actions require anti-CSRF protections and safe session cookies. Nonce-based wallet session has domain binding, expiry and replay protection.

| Surface | Required contracts |
|---|---|
| Owner | POST /session/challenge, POST /session/verify, GET /workspace |
| Agents | POST /agents, PATCH /agents/:id/config, POST /agents/:id/run, POST /agents/:id/pause, POST /agents/:id/revoke |
| Workspace | POST /workspace/stop, POST /workspace/policy, GET /activity, GET /balances |
| Wallet | POST /deposits/prepare, POST /deposits/register, GET /notes/status, POST /exits/prepare, POST /recovery/prepare |
| Internal purchases | POST /purchase-intents, GET /purchases/:id, POST /purchases/:id/reconcile |
| Gateway | GET /health, POST /quotes, POST /v1/purchases/:quoteId/execute, GET /v1/purchases/:quoteId/result, GET /credits/balance |
| Credits | POST /usage/authorize, POST /usage/execute, GET /usage/:operationId |
| Content | GET /content, PATCH /content/:id, POST /content/:id/review, GET /calendar |
| Relayer/indexer | GET /deployment, GET /public-state, POST /withdrawals, GET /withdrawals/:id |
| Facilitator | GET /supported, POST /verify, POST /settle via conforming SDK |

Tools exposed to agents: catalog lookup, budget summary, request purchase, purchase status, consume approved inference SKU, save research/content artifact and request allowed local handoff. No seed access, raw signTransaction, arbitrary destination transfer, policy mutation or publishing tools.

Error codes: POLICY_DENIED, BUDGET_EXCEEDED, SERVICE_NOT_ALLOWED, PRICE_CHANGED, WRONG_NETWORK, WRONG_MINT, ACCOUNT_STOPPED, APPROVAL_REQUIRED, PRIVACY_WARNING, NOTE_PENDING, SETTLEMENT_UNCERTAIN, QUOTE_EXPIRED, IDEMPOTENCY_CONFLICT, PROVIDER_UNAVAILABLE, PAID_NO_RESULT, RECOVERY_REQUIRED. Policy failures include safe actionable reason but no secret note identifiers in public gateway errors.

## 12. UI requirements

Workspace presents three clearly different agent roles, a shared treasury summary, live jobs and recent outputs. Create/configure forms show effective policy and require owner activation. Show per-agent and global remaining limits together; don't imply an agent can spend all displayed pool value.

Agent detail shows settings, trigger, active job, result history and spending. Content view presents editable drafts and a simple calendar with review status. Activity drawer shows multi-leg state and explorer links. Recovery center explains pending versus safe-to-recover funds. Privacy panel states what remains public and whether membership information suggests a weak pool. Devnet badge and operator-funded-inference label remain visible.

Use explicit human labels: “Paid; result unavailable,” “Waiting for confirmation,” “Stopped; one payment already authorized,” and “Credits purchased; no extra on-chain charge for this call.” An animation of dots is optional; real state changes and useful outputs are mandatory. Accessible controls, keyboard navigation and mobile-readable dashboard are required. UI imagery is not required for functional acceptance.

## 13. Security and enforcement boundaries

On chain/proof: note ownership, approved-set membership, range-checked value conservation, nullifier uniqueness, exact withdrawal intent and owner exit. Owner wallet service: budgets, merchant selection, revocation and signing validation. Gateway: credit issuance, usage debit, result caching and upstream cost bounding. Model: proposes plans and explains actions, never acts as security authority.

Off-chain caps MUST NOT be advertised as cryptographic caps. A compromised owner service may steal notes or bypass its own policy; a malicious setup or buggy verifier may compromise the pool. Local secrets are not hidden from the owner machine. A third-party-hosted prover would add a new trusted party and is outside the accepted design.

Public receipts never include notes, refund seed, decryption keys or prompt secrets. Role authentication cannot be spoofed by passing another agent ID in JSON. Separate gateway admin, owner control and worker credentials. Program/admin powers, approved-set operator and fee sponsorship identities are documented. Recovery cannot be executed with stale worker permissions.

External links/data are untrusted input. Prompt-injection detection is optional; tool authorization always applies. Content management means drafting in the workspace, with no external publishing authorization implied.

## 14. Build milestones and exit criteria

### M0 — Reproducible foundation

Create monorepo, schemas, migrations, authenticated local services, configuration validation and scripted setup. Add .env.example with no secrets and documentation of credentials. Lock dependencies. Single command starts dashboard, services and workers after setup. Devnet-only network guard rejects mainnet. Exit: fresh database boots, login/configuration works, wrong genesis/mint fails closed.

### M1 — Ordinary x402 plus real inference

Implement standard devnet exact payment, conforming local facilitator and immutable quote/cache binding. Merchant ATA and fee sponsor setup are scripted. Gateway returns real bounded OpenRouter output only after settlement. Exit: actual devnet signature and provider request/result; repeated execute returns same result without another debit; no claim of private payment at this milestone.

### M2 — Private pool feasibility

Specify note/intent vectors and refund authority; compile spend/insert/exit, generate development artifacts with hashes, deploy pool, deposit and approve multiple labeled test notes. Execute real proof withdrawal, change insertion and owner exit, then use a fresh signer for M1 merchant payment. Measure compute, instruction/account sizes, proof latency, rent and concurrency. Exit: all core invariants tested and actual private payment signatures exist. Do not expand UI or claim privacy if this gate fails.

### M3 — Independent caps and recovery

Implement atomic budget/note reservations, all scope limits, policy epochs, revocation races, retries and startup recovery. Exit: concurrent agents cannot exceed global allowance; timeout/restart never blindly creates a new purchase; stopped funded wallet has a safe owner recovery path.

### M4 — Durable credits and Shawn

Implement gateway ledger, authenticated usage permits, bounded inference SKUs, credited-once packs, low-balance job leases/cooldown and expenditure/consumption separation. Exit: Shawn replenishes once, repeated triggers/restarts issue no extra pack, actual inference reduces credit units exactly once, caps halt further purchases.

### M5 — Prince and Mira

Implement restricted runner with bounded planning, one meaningful service choice, research artifacts and approved local research-to-content handoff. Content editing/calendar has no hidden inference or publishing. Exit: research result plus three content drafts and seven-day calendar; all consumed resources visible and limited.

### M6 — Full demo and review materials

Dashboard, backup/restore, privacy caveats, adversarial evidence, README, architecture, security self-assessment, source attribution, deployment/run steps, transaction links and optional demo video. Exit: an agent/operator following README can reproduce three roles and the acceptance suite using their own test credentials.

Priority order is mandatory; date estimates depend on existing code and M2 results. The screenshot deadline is October 20, 2026 at 23:59 UTC+8, Kuala Lumpur time. Do not promise a safe new protocol in six days. If constraints require cutting scope, report the cut explicitly; retain real private core, actual x402 and independent financial controls.

## 15. Test and acceptance matrix

| ID | Test | Required evidence/result |
|---|---|---|
| NET-01 | Mainnet/wrong mint config | Startup and payment reject |
| X402-01 | Exact ordinary payment | Devnet settlement plus real bounded inference |
| X402-02 | Wrong amount/ATA/authority/fee payer/instruction | Complete verifier rejects |
| X402-03 | Same signature on another quote/account | No second fulfilment or credit issuance |
| X402-04 | Same operation with changed request | 409 conflict, no charge |
| PRIV-01 | Valid spend and change | On-chain real proof accepted; change note spendable |
| PRIV-02 | Bad proof/context/public input | No release of value |
| PRIV-03 | Same nullifier twice | Second spend/exit rejected |
| PRIV-04 | Underflow/wrapped values/wrong root | Rejected; no invented balance |
| PRIV-05 | Forged insertion/genesis/duplicate precommitment | Rejected or authenticated queue invariant preserved |
| PRIV-06 | Unapproved original and change owner exit | Private pay rejected when required; valid public exit works |
| PRIV-07 | Multiple labeled test deposits | No explicit spent-deposit identifier in withdrawal; metadata caveats documented |
| CAP-01 | Per-purchase/task/agent/global cap | No proof/signature released beyond any cap |
| CAP-02 | Two agents race for final allowance | Atomic authorization admits only permitted exposure |
| CAP-03 | Uncertain payment crosses rolling window | Reservation still counts |
| CAP-04 | Lower limit below pending exposure | New spend blocked, exposure visible |
| REV-01 | Pause before signing / proof released | New authority blocked; released material handled honestly |
| AUTH-01 | Agent passes another agent ID | Scope mismatch rejected |
| AUTH-02 | Role tries arbitrary sign/policy edit/publish | Tool unavailable or independently denied |
| IDEM-01 | Same logical purchase repeatedly | One financial operation; same state/result |
| REC-01 | Restart at every multi-leg boundary | Notes/keys/credits/reservations restored and reconciled |
| REC-02 | Lost settlement response | Reconcile existing signature; no blind new debit |
| REC-03 | Fresh-wallet recovery conflicting with signed tx | Wait for proven safe outcome; only owner destination |
| CRE-01 | Restart after settle before issue | Issue pack once |
| CRE-02 | Two usage requests over available credits | One bounded outcome; no negative credits |
| CRE-03 | Shawn sees low credits repeatedly | One unresolved top-up; cooldown/caps hold |
| CRE-04 | Usage permit replay/modified digest | No second debit/inference |
| CRE-05 | Top-up then consumption dashboard | No double-counted USDC expenditure |
| LLM-01 | Upstream timeout/price change/exhausted account | Fail closed or visible uncertain outcome; no uncontrolled retry |
| AGT-01 | Prince service choice | Useful brief and attributable purchased evidence |
| CNT-01 | Mira from approved handoff | Direct private devnet x402 signature, real inference, three editable drafts and seven-day calendar |
| CNT-02 | Edit/approve/calendar change | No hidden charge or external publish |
| SEC-01 | Malicious service asks for funds/policy change | Independent rejection; no reliance on model refusal |
| SEC-02 | Prompt/log inspection | No secret notes, keys or sensitive auth material |
| BAK-01 | Restore backup with pending spend | No address reuse, duplicate purchase or lost change |
| LED-01 | Pending change and external recovery | Change unavailable before insertion; external recovered principal creates no pool note |
| EXIT-01 | Attacker signer with valid note proof | Derived label mismatch rejects; correct owner original/change exit succeeds |
| EXP-01 | Old proof in fresh-blockhash tx after bound | Clock/context check rejects; no premature reservation release |
| QUO-01 | Accepted tx settles after quote expires | Honor original price once; paid retries return cached result |
| QUO-02 | Re-quote funded operation | Existing funding reused/recovered; no second automatic withdrawal |
| USG-01 | Failure between scoped/account reservation | Reconcile same operation; no double debit or excess consumption |

Use meaningful negative tests and deterministic fault injection around commits/network requests. Circuit tests use real proofs and matching vectors; no mocked verifier for acceptance. Integration evidence reports test counts, environment and failed/skipped tests. Preproduction security review is separate; passing prototype tests does not establish audited safety.

## 16. Demo script and evidence package

1. Show devnet, private pool, membership limits and three agent policies.
2. Show Shawn's usable credits below threshold; execute the same scheduled check manually for recording.
3. Show real proof-funded fresh wallet, exact x402 payment and one credit issuance.
4. Start Prince research and show approved data choice, credit usage and an attributable brief.
5. Approve the local handoff and run Mira; show her direct private devnet x402 content purchase, content drafts/calendar and categorized resource use.
6. Trigger a duplicate purchase check; show no new payment/result execution.
7. Show concurrent over-budget request rejection and independent agent revoke.
8. Demonstrate owner recovery/public exit separately with its privacy warning.

Evidence contains deployment manifest, artifact hashes, devnet program/mint/recipient addresses, deposit/withdrawal/merchant/exit signatures, redacted owner ledger, expected results and screenshots. Explicitly separate operator-funded commercial inference, demo-data routes and genuine test-chain payments. Never publish real secrets to make the demo reproducible.

Submission artifacts: source with attribution and applicable licenses; README; technical architecture/core algorithm; security self-assessment with permission tiers and known risks; short presentation; real transaction hashes; optional video within screenshot limits. Prepare independently of unresolved organizer clarification.

## 17. Operator configuration and human action items

Required for a real-inference run: an OpenRouter API key with separately funded real credits and a restricted provider spend limit; a selected allowed model; working devnet RPC; devnet SOL sponsor; test mint funds; owner-connected wallet; local encryption/backup secret. No actual key belongs in the specification, repository, chat or evidence. Put secrets in local environment/secret storage. No mainnet funds or social credentials are needed.

Human actions before the integrated demo:

- Confirm competition accepts Solana devnet transactions and reference-code reuse.
- Provide a funded OpenRouter key to the local gateway setup (or choose an equivalent inference provider); this is the only commercial service dependency in the default demo.
- Review the configured agent budgets and target demo content/topic. Defaults allow implementation to proceed; these do not block writing code.

Implementation-agent actions: verify devnet facilitator/mint compatibility, select/pin a supported model SKU, measure ZK path, generate artifacts, document sponsor/rent costs, build backup/recovery and run tests. Do not shift these technical decisions onto the user unnecessarily.

### 17.1 Funded setup wallet and verified devnet snapshot

Owner reports the setup wallet funded. Public finalized RPC check on October 14, 2026 confirmed:

- Setup wallet: 3FCio7smQJX7fm5x4Rz2UPPesfHA46FkexC3S3SqkMFd.
- Solana devnet RPC: https://api.devnet.solana.com.
- Full genesis hash: EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG.
- Native balance: 10,000,000,000 lamports = 10 devnet SOL.
- Pinned test-USDC mint: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU; six decimals.
- Existing wallet token account: 8xGGTRNvvnSX9E6ZkRBqNjFFs36FWXr98csdScZQxj92.
- Test-USDC balance: 20,000,000 base units = 20 test USDC.

This is a point-in-time snapshot, not an always-current balance or proof of deployment. Startup and deployment recheck live finalized balances and chain identity. A wallet can own token accounts that are not the canonical ATA; scripts verify the recorded account's owner/mint and derive required ATAs independently.

Local keypair was generated with operating-system randomness using Ed25519, saved in work/keys/veilo-devnet-funding.json with mode 0600 inside a mode-0700 folder and a local Git exclusion. It is a software test signer, not encrypted/hardware-backed and not a connected Phantom account. Scripts accept its path explicitly; they never print key material or commit the file. Do not replace this keypair after funding. Future operator backups preserve it securely.

Use this wallet as the devnet bootstrap funding source. Deployment/rent/fee sponsorship use test SOL; user-demo pool deposits use test USDC. Derive/create separately labeled deployer, sponsor, merchant and test-owner roles before the integrated demo; scripts persist their keys once, record public mappings and never silently regenerate them. Sponsorship stays separate from the identifiable user deposit wallet in the demonstrated private flow. Bootstrap transfers are public and may reveal common operator funding; role separation does not establish independent-user anonymity.

Deployment script requirements: verify full genesis and mint; estimate binary/program-account rent and fees; show a budgeted test-SOL plan; fund only required demo roles; deploy the program; initialize a correctly derived vault with pinned authorities/keys; precreate merchant ATA; verify on-chain state and facilitator support; record program/pool/vault addresses and transaction signatures. Deposits enter the actual pool only after those checks. Current wallet funding is not an automatic pool deposit, and no deployment/transfers were performed during this specification update.

Do not assume 10 SOL covers every build/deployment attempt: measure compiled binary size, rent and balances and report a shortfall. Preserve sufficient sponsor funds for end-to-end transactions and owner recovery. Every executable flow rejects mainnet. Provider-funded real inference is independent of these balances.

Owner rejected the proposed separate task credit-bucket change. Retain the original shared ZK pool, fresh payment wallets, ordinary x402 merchant payments and one shared gateway credit account for Shawn's replenishment scenario.

## 18. Source evidence and reuse

Retain required third-party notices for reused code and keep historical external evidence separate from Veilo execution evidence.

Primary implementation sources:

- https://solana.com/docs/payments/agentic-payments/x402 — V2 SVM protocol, network/mint and SDK flow.
- https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md — exact scheme verifier contract.
- https://github.com/Lightprotocol/groth16-solana — Solana BN254 verifier candidate.
- https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion — upstream inference API.
- https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits — operator credit monitoring; management credential required.
- https://www.ieee-cis-singapore.org/2026-fintechathon — public competition overview, plus supplied screenshots.
- https://solana.com/docs/core/pda — PDA vault authority; no private key.
- https://solana.com/docs/core/cpi — program-authorized SPL transfers via invoke_signed.

External x402/OpenRouter gateways demonstrate feasibility as project claims, but are not audited dependencies or verified devnet services. Veilo uses its own durable conforming gateway implementation by default. This specification specifies expected behavior; no live Veilo integration, cryptographic audit or deployed program is implied.

## 19. Configuration defaults and handoff commands

The implementation must provide these documented commands; they are requested interfaces, not commands currently available in this planning workspace:

```
pnpm install
pnpm setup:local
pnpm dev
pnpm check
pnpm test
pnpm test:circuits
pnpm test:integration
pnpm deploy:devnet
pnpm demo:seed
pnpm demo:run
pnpm evidence:export
pnpm backup
pnpm restore -- --file <encrypted-backup>
```

Local setup does not spend commercial credits. Provider connectivity is a separate explicit smoke test with the operator ceiling configured. Deployment and test scripts require devnet verification before using any signer. CI uses mocked upstream inference for repeatable tests but real circuit proofs; an opt-in live-inference integration run produces provider evidence. Circuit fixtures are regenerated only through documented commands and never weakened to make a test pass.

Environment template must include DEVNET_RPC_URL, EXPECTED_DEVNET_GENESIS_HASH, DEMO_TOKEN_MINT, FACILITATOR_URL, POOL_PROGRAM_ID, POOL_ID, DEPLOYMENT_MANIFEST_PATH, OPENROUTER_API_KEY, PLANNER_MODEL_ID, INFERENCE_MODEL_ID, OPERATOR_MAX_REAL_USD_MICRO, SPONSOR_KEY_PATH, OWNER_SERVICE_SECRET_PATH, CONTROL_DATABASE_PATH and GATEWAY_DATABASE_PATH. Missing provider spend ceiling defaults to zero and disables real inference until configured. File-path secrets are never printed. Gateway and wallet/control databases can be separate, but all owner policy/note reservations must transact through the same authoritative owner ledger. Cross-service financial events use durable outbox/inbox processing and unique event IDs; do not pretend separate SQLite commits are one atomic transaction.

Proposed activation defaults for owner review, expressed in illustrative test units:

```json
{
  "network": "solana-devnet",
  "workspace": {
    "lifetimeTestUsdc": "10000000",
    "rolling24hTestUsdc": "5000000",
    "sponsorLamportLimit": "100000000",
    "mode": "bounded_automatic"
  },
  "agents": [
    {"name": "Shawn", "role": "credit_manager", "lifetimeTestUsdc": "3000000", "rolling24hTestUsdc": "3000000", "maxPurchaseTestUsdc": "1000000", "creditLowWatermark": "200000", "creditPackUnits": "1000000", "pollSeconds": 60, "cooldownSeconds": 600},
    {"name": "Prince", "role": "research", "lifetimeTestUsdc": "2000000", "rolling24hTestUsdc": "2000000", "maxPurchaseTestUsdc": "500000", "taskCreditUnits": "400000"},
    {"name": "Mira", "role": "content", "lifetimeTestUsdc": "2000000", "rolling24hTestUsdc": "2000000", "maxPurchaseTestUsdc": "500000", "taskCreditUnits": "400000"}
  ]
}
```

Test-unit amounts are base-unit integers, not dollars. Demonstration ceilings are edited by the owner before activation; a worker cannot widen them. Supply concrete immutable provider SKU and allowed-service catalog during seed, not unknown freely selected model identifiers. Zero actual-provider spend ceiling remains the safe default until the operator configures it.

Operator dollar usage uses a separate bounded ledger. Reserve worst-case input/output cost at the currently pinned SKU tariff before every provider request, including sponsored planning. Stop if pricing is stale, the reservation exceeds OPERATOR_MAX_REAL_USD_MICRO, or provider account/key limits are insufficient. Record actual reported cost when known; ambiguous calls retain reservations. Provider credentials must also enforce a funded account/key ceiling because an application ledger cannot constrain a compromised gateway. These actual costs do not count as payments made with demo USDC.

After downtime, coalesce missed threshold checks into one current observation. Never replay an unbounded queue of missed scheduled purchases. Rejected top-up episodes pause until a meaningful balance/policy change or owner retry; no automatic new operation IDs to defeat a denial.

## 20. Definition of done

The project is ready for submission only when a fresh operator can follow setup, deploy/test the private devnet path, fund a workspace, configure the three agents, obtain real bounded inference and useful research/content output, observe one genuine autonomous top-up, reproduce cap/revoke/idempotency/recovery tests, and inspect transaction evidence with accurate privacy/trust explanations.

A pretty multi-agent workspace with mock privacy is incomplete. A working privacy rail with fake autonomous behavior is also incomplete. End-to-end means both, with bounded execution, durable state and evidence.


## 21. Repository bootstrap and CLAUDE.md preparation task

**T00 is mandatory and runs before coding.** Part II contains the exact CLAUDE.md contribution policy to install in the implementation repository root. Extract that part into CLAUDE.md, rather than asking another agent to improvise equivalent rules. In this projectless planning workspace the deliverables live under outputs/; a new build repository must receive this PRD_latest.md at its root and extract Part II to CLAUDE.md; supporting evidence/reference sections may be extracted under docs/references/. No separate implementation prompt file is required.

Inspect any existing AGENTS.md/CLAUDE.md and preserve applicable instructions and user work. Do not initialize Git at the parent Documents/Codex folder, include reference clones as the product source tree, or add the local funded keypair to a repository. If no repository has been selected, create a contained implementation directory with its own Git boundaries and document that path. A reference clone under work/ is research material, not the build target.

CLAUDE.md MUST state:

1. No Claude/Anthropic/AI author or committer identity and no AI Co-authored-by trailer. Use configured human identity; never fabricate or silently alter it.
2. Source comments are concise, necessary and accurate, explaining only this codebase. No explanatory comment mentions specification, reference projects, the conversation or AI generation. Attribution belongs in README/NOTICE/licenses; required legal notices remain intact.
3. Conventional Commits: type(scope): imperative description. Conventional branches: type/short-kebab-description. Allowed types and examples are in CLAUDE.md.

When commits are authorized, stage only intentional product changes, inspect staged diff for secrets and use focused checkpoints after relevant validation. Missing human Git identity is a commit-specific blocker, not a reason to stop coding. Do not rewrite history or claim another person's contributions. No push, PR publication, social posting, provider billing changes or mainnet deployment is implied by these contribution rules.

## 22. Ordered implementation backlog

Maintain docs/build-status.md. Each task has not-started/in-progress/blocked/done state, dependencies, actual commands/checks and evidence links. A done task cannot have skipped mandatory acceptance without a documented failure. Follow the dependency graph; keep independent local work progressing when a live credential is missing.

| Task | Dependencies | Required deliverables | Completion gate |
|---|---|---|---|
| T00 Repository and contribution policy | None | Root contribution instructions and product requirements, inspected worktree, human identity check, conventional branch decision, secret ignores | Correct repo boundary; no key/parent folder tracking |
| T01 Toolchain and monorepo | T00 | Pinned package manager/runtime/Rust/Anchor/Circom/snarkjs versions, lockfiles, setup/health scripts | Reproducible local boot and check; no floating latest in release instructions |
| T02 Schemas and durable ledger | T01 | Migrations, decimal-string validation, immutable financial events, uniqueness constraints, outbox/inbox | CAP/IDEM/ledger unit tests pass, all writers use authoritative control ledger |
| T03 Owner session and worker boundaries | T01–T02 | Signed login challenge, scoped worker auth, secret separation, policy editing/revoke | AUTH/SEC tests; model tools cannot sign or change policy |
| T04 Ordinary devnet x402 | T01–T03 | Pinned SVM adapter, immutable quotes, managed capability checks, Echo smoke script and local gateway stub | Verified exact-mint payment; paid/pending retry ordering tested |
| T05 Protocol specification and vectors | T01 | docs/protocol.md with actual schemas, constants, encodings, queue/cancel rules and vectors | Cross-language vectors identical; all public-input/mint/domain/exit bindings specified |
| T06 Circuits and verifier | T05 | Real spend/insert/exit circuits, setup provenance, hashed artifacts, Rust verifier integration | Real accepted proof plus meaningful failing proofs; compute/size measured |
| T07 Pool program and local adversarial tests | T02,T05–T06 | All instructions/PDAs, owner exit/refund, init checks, nullifier retention, zero-fee configuration | PRIV/EXIT/EXP/account substitution tests; no privileged sweep |
| T08 Private SDK/indexer/relayer | T03,T05–T07 | Encrypted notes, reserved keys, witnesses, public replay, sponsorship and restricted recovery | Original/change spend and exit; restart restores state; relayer never receives note secrets |
| T09 Devnet private integration | T04,T07–T08 | Budgeted deployment, actual manifest/addresses, sample deposits, proof withdrawal then ordinary x402 | M2 end-to-end real chain evidence, no mock privacy |
| T10 Gateway credits and inference | T02–T04 | Durable shared account, credit packs, usage permits, result cache, bounded OpenRouter adapter | CRE/USG/LLM tests; opt-in real inference with separate provider ceiling |
| T11 Shawn scheduler | T02–T03,T09–T10 | Deterministic threshold checks, durable episode ID, lease/cooldown, one unresolved top-up | Repeated checks/restart produce one issuance; actual private x402 pack purchase |
| T12 Prince research | T03,T09–T10 | Restricted bounded planning/tools, priced service comparison, sourced research artifact | Actual paid data purchase and meaningful output; fixture sources labeled |
| T13 Mira content | T03,T09–T10,T12 handoff interface | Owner-approved local handoff, direct-USDC purchase, drafts/revisions/calendar | CNT tests; actual content purchase, real inference, no publishing authority |
| T14 Dashboard and owner recovery | T03,T08,T10–T13 | Agent cards, policy forms, activity, credit/token accounting, drafts/calendar, privacy/recovery views | Every state reflects backend truth; keyboard controls and all stop paths work |
| T15 Integrated fault injection and restoration | T09–T14 | Crash-boundary tests, uncertain payment/provider tests, backup/restore, cap/revoke races | Relevant section15 matrix passes with evidence and no duplicated funds/results |
| T16 Handoff and submission materials | T15 | README, architecture/security documents, source/license attribution, evidence export and demo script | Fresh-operator reproduction; all limitations and external dependencies visible |
| T17 Marketplace discovery gate | T00–T08 | Inventory per §26.2; frozen quote/payment/result schemas; gap list | No migration or contract change before this gate |
| T18 Identity and protected product data | T17 | Supabase wallet sign-in, workspaces, RLS/grants, private Storage, sanitized public catalogue, seller review | Anonymous/buyer A/buyer B/seller/worker negative tests; no cross-tenant read/write or secret exposure |
| T19 Generic agents and free execution | T17–T18, T11–T13 | Template-driven agents replacing fixed roles (existing three become templates), durable job board, leases, input requests, artifact validation | Free jobs end to end; crash/duplicate delivery yields one current result |
| T20 Direct paid hiring | T09, T19 | Immutable quotes bound to the local control/wallet path, per-listing seller recipient, finality-verified receipts, zero-fee earnings index | One finalized payment → one job and one earnings event; ambiguous outcomes stay blocked |
| T21 Agent discovery and approved automation | T20 | Agent search/propose, owner approval of new sellers, schedule dedupe, revocation | Malicious listing/tool text cannot expand permission, change recipient or buy unapproved service |
| T22 Connectors and remote sellers | T21 | Reviewed MCP/API adapters, credential broker, authenticated seller callbacks | Least privilege, revoked grants and callback authenticity tested; new seller earns from a real devnet job |
| T23 Marketplace recovery and release readiness | T22 | Refunds, uncertain settlement, offline controller, stale worker, restore, suspension | §26.6 acceptance checks pass with evidence |
| T24 Paid tool listings and connectors | T20, T22 | Provider adapters on the seller host (Higgsfield, MakeUGC, Zernio and a research provider once verified), pinned tool manifests, server-side provider credentials, per-agent connector grants; demo agents buy their tools on chain | Each adapter verified against the provider's official API/MCP docs; a paid devnet call per tool with evidence; no provider credential reachable by agents or the runner |
| T25 Workflow agents | T24 | Versioned workflow definitions over published tool listings, review and publication, owner-approved workflow budget, controller-executed steps with per-step quotes, payments and artifacts | §26.7 acceptance rows pass; one multi-step devnet workflow run with one receipt per step |

T04 can precede ZK implementation as a payment feasibility baseline. T10 can use fixture upstream inference in local automated tests while T06–T09 progress. Live inference cannot be marked complete without real output. Frontend scaffolding can run independently, but no gate is passed by fake UI events.

Use small reviewed modules and tests organized around invariants, not a huge generated single file. Avoid building P1/P2 capabilities before P0 completion. Report the measured failing gate with retained work if a circuit or runtime limit prevents completion.

## 23. Source and adaptation records

Preserve required copyright and third-party license notices in NOTICE and redistributed dependencies. Source comments explain local behavior. Record execution evidence from the actual Solana deployment.

## 24. Complete run contracts, failure behavior and outputs

### 24.1 Setup and deployment contract

setup:local validates toolchain and creates schema/config directories with protected permissions. It does not replace funded keys, acquire commercial credits or make automatic chain payments. demo:seed is idempotent: creates three roles, one shared gateway account, fixed SKUs, explicit demo policies and licensed datasets; it never replenishes balances just because it was rerun.

deploy:devnet takes explicit key paths, verifies genesis/mint, computes a bounded plan, records program binary/key hashes and manifests, initializes only once and resumes verified partial steps. Re-running cannot create another vault with the same logical pool or overwrite proving keys. A changed circuit/program protocol requires a new compatible manifest and a tested old-pool exit plan.

demo:run creates an explicit unique demo run, verifies pool/gateway/provider readiness and requested allowances, then invokes backend paths rather than fake dashboard events. If real inference is disabled, it reports a blocked real-demo gate and may run visibly labeled fixture diagnostics separately. No mainnet fallback, silently substituted token, social publishing or real provider top-up.

### 24.2 Failure matrix

| Failure | Safe behavior | Owner-facing result |
|---|---|---|
| Wrong genesis/mint or incompatible artifact | Fail closed before signing | Configuration mismatch, no payment |
| Pool root too old / queued change not inserted | Rebuild/reconcile same logical operation; no second authorization | Waiting for pool state |
| No suitable approved quote fits allowance | Stop or return incomplete useful work | Budget/provider limitation |
| Relayer timeout after proof release | Retain reservation; reconcile nullifier until bound resolves | Withdrawal outcome pending |
| Merchant settlement reply lost | Track claimed signature to finality | Payment outcome pending |
| Paid service execution fails or is unknown | At most one automatic upstream attempt; retain honest status | Paid; result unavailable/uncertain |
| Credit issuance reply lost | Replay same payment event/issuance ID | Credits pending, no second top-up |
| Actor revoked during run | Stop unreleased authority; handle live transactions and owner recovery | Stopped with pending exposure |
| Content schema invalid | Save error/partial result; repair requires budgeted explicit new attempt | Draft incomplete, no hidden retries |
| Operator actual-dollar allowance exhausted | Stop provider calls; keep dashboard/control available | Operator inference allowance exhausted |
| Note backup/restore validation fails | Do not fund/spend until reconciliation | Recovery requires attention |

### 24.3 Required deliverables in the implementation repository

- Root PRD_latest.md and extracted CLAUDE.md, current README and secret-free .env.example.
- Runnable monorepo with lockfiles/migrations, command scripts and meaningful acceptance tests.
- docs/protocol.md: actual encodings, circuit signals, accounts, instruction constraints, arithmetic and state invariants.
- docs/architecture.md: actor boundaries, sequence diagrams, ledger ownership and gateway/provider separation.
- docs/security.md: threat model, permission tiers, administrator/setup risks, privacy observers, limitations and test evidence.
- docs/deployment.md: toolchain, finalized devnet manifest, funded-role requirements, resume/exit/recovery and cost measurements.
- docs/build-status.md: task graph, gate states and narrow blockers with evidence.
- docs/references/ with provenance and license map; no fabricated audits or reused transaction attribution.
- Sanitized evidence package containing successful and negative test outcomes, actual Solana signatures, real inference receipt/status and useful final artifacts.
- Owner-local encrypted backup with a verified restore procedure; backup secrets stay outside public deliverables.

The builder must implement definitions, not just documentation/screens. Unimplemented endpoints are clearly not-ready and fail safely; they never return success-shaped mock payments in live mode.

## 25. Final scope decisions and remaining external inputs

| Decision | Final requirement |
|---|---|
| Chain/asset | Solana devnet with verified test-USDC mint; SOL only for chain costs |
| Private rail | Shared note-based ZK pool, fresh signer per purchase, real proof verification |
| Wallet authority | Owner-operated local service; restricted model tools, off-chain caps disclosed |
| Workspace | Three P0 roles; Shawn shared-credit replenishment, Prince paid research, Mira direct-USDC content |
| Content | Local editable drafts/calendar; no external posting |
| Payment protocol | x402 V2 exact, tested PayAI default; Kora self-hosted fallback |
| Commercial provider | Operator-funded OpenRouter, separately capped real dollars; devnet assets do not buy real provider credits |
| Credit architecture | One shared gateway account for the top-up example; no task credit buckets |
| Risk features | Deterministic policy enforcement P0; optional anomaly flagging deferred |
| Git | Human configured identity, concise code-specific comments, conventional commits and branches |

No further broad product approval is needed for this specification. Remaining human inputs are a locally supplied funded/restricted inference credential and ceiling for the live run, review of activation budgets/demo topic, and organizer eligibility confirmation. The builder handles technical protocol encodings, SDK compatibility, deployment feasibility and recovery implementation. If it cannot meet the private-core gate, it reports the evidence and does not silently remove privacy.

No guarantee of PMF, winning, robust anonymity or production safety follows from this document. Real prototype execution and customer validation are separate work.

## 26. Marketplace extension (v3.2)

### 26.1 Scope

Veilo adds a marketplace of paid specialist agents. Owners create arbitrarily named agents with their own instructions, triggers, tools and independently enforced limits. Sellers publish fixed-price, fixed-scope specialists after operator review and are paid directly. Buyers hire manually, or let their own agent discover and propose a specialist within owner-defined permissions. Models still only propose; the owner's local control service still authorizes every payment.

First release MUST include: wallet sign-in; a searchable catalogue of reviewed listings; self-service seller setup with review before publication; one specialist per hire; a private job board with input requests, downloadable deliverables and receipts; direct seller settlement through a verified x402 V2 exact endpoint; a zero platform fee shown explicitly in every quote and receipt; seller earnings as a history of settled chain receipts, never a withdrawable balance; managed templates and reviewed remote endpoints only, with no arbitrary uploaded code; read-only connectors by default.

Deferred: auctions, reputation, escrow, automatic refunds, paid recursive delegation (a seller or step never spends the buyer's funds; delegation depth is one), open code hosting, seller-funded bundles that resell other sellers' work, and nonzero fees. Workflow agents (§26.7) are in scope because every step is a separate purchase made by the buyer's own controller.

### 26.2 Architecture and authority

Hybrid. Supabase (Auth, Postgres, Storage) holds accounts, the public catalogue, private jobs, artifact metadata and accounting projections. Solana records settlement. The owner's local control and wallet services remain authoritative for policies, reservations, revocation epochs, notes, proofs and signing. Cloud policy records are proposals until local control installs and acknowledges them. A Supabase session never authorizes spending. Local control connects outbound with authenticated, digest-bound, expiring requests; automatic spending pauses while it is offline.

Two sign-ins are deliberate: Supabase Web3 sign-in for marketplace identity, and the existing local challenge sign-in for spending authority. Do not replace the local login, and do not build a second custom cloud auth service.

T17 MUST record: the repository and commit; service entry points; existing schemas and state machines; program/circuit/artifact identities; proof and recovery test status; the x402 SDK, facilitator and recipient rules; the wallet trust boundary; and the existing auth, queue and deployment.

### 26.3 Data and access

Use integer base units transported as decimal strings, explicit network and mint, immutable listing, payout, quote and runtime versions, append-only job and financial events, and unique operation, receipt and earnings constraints. Enable RLS on every exposed table and grant explicitly. Serve the catalogue from a sanitized projection. Clients get no UPDATE on quotes, jobs, payments or earnings; trusted transition APIs enforce actor and state. Storage buckets are private per job participant, with short-lived signed links. Keep service keys server-side only.

### 26.4 Settlement

The quote names the seller's verified payout recipient. The wallet funds a fresh signer from the pool, then pays that recipient by ordinary public x402 exact. Execution starts only after independently verified finality, or for an explicitly free quote. Fee F = floor(B × r / 10000), with r = 0 in this release. If the gateway accepts only its own recipient, block managed paid listings until per-listing recipients are implemented and verified; never route seller funds through the operator. Refunds are seller-funded transfers to an owner-verified address, capped at the settled amount, and counted only when finalized. Label all amounts as test tokens.

### 26.5 Privacy and runtime boundaries

§7.4 applies unchanged. The marketplace operator, sellers, facilitators and model providers can see the buyer→seller relationship and plaintext job content they process; pool funding hides only the on-chain deposit→payment link. Hosted execution needs isolated, egress-controlled attempts with no wallet secrets. Treat tool, listing and result text as untrusted data. Default limits: 10 minutes active, 8 tool calls, one attempt, quote TTL 5 minutes, lease 60 s with a 15 s heartbeat, 20 MiB per upload, 10 attachments, 30-day content retention.

### 26.6 Acceptance

- A connected but unsigned wallet cannot read private records.
- Buyer A cannot read buyer B's data through the API, database or Storage.
- A seller sees only assigned job data and cannot change price, recipient, participants or payment state.
- Switching wallets does not transfer ownership.
- A changed recipient, mint, network or amount, an expired quote, or an unapproved seller is rejected locally.
- Concurrent hires cannot exceed any budget.
- One receipt funds exactly one job and creates one earnings event.
- Lost withdrawal or settlement replies and a post-settlement worker crash produce no duplicate payment.
- Settled-but-failed jobs stay visibly paid.
- Refunds cannot exceed the payment.
- A stale lease cannot complete a job.
- Malicious result files cannot run scripts in the app origin.
- The controller being offline means no new spending.
- No pool contract change is made solely for the marketplace.

### 26.7 Workflow agents (v3.3)

Any signed-in account may publish a **workflow agent**: a versioned, reviewed chain of published tool listings, for example *Higgsfield (generate visual) → MakeUGC (produce UGC video) → Zernio (draft a scheduled post)*. A workflow is a recipe, not a new spending authority.

- **Definition.** A workflow version names its ordered steps (listing version, fixed input template, which earlier artifact feeds which input), a per-step price taken from each listing's published version, the total, and the expected deliverable. Steps may only reference published listings or operator-approved external x402 bindings; a changed listing version requires a new workflow version.
- **Who publishes.** Any signed-in account can create and publish workflows through a self-serve builder. A workflow composed only of already-published listings and approved bindings publishes immediately after automated checks (schema, mappings, maxima, payout proof, safety-promise text), because it introduces no new endpoint or credential. Connecting a new tool (a new provider adapter, remote seller origin or external x402 binding) still requires operator review before any workflow can use it. The operator can suspend any workflow or tool at once.
- **Payment model.** Hiring a workflow produces one quote per step. The buyer's local controller pays **each step's seller directly** through the existing private x402 path, with its own payer binding, receipt and earnings event. Nobody resells another seller's work and no step spends the buyer's funds. The workflow author may optionally sell an orchestration step of their own, priced and paid like any other step; zero platform fee still applies.
- **Authorization.** The owner approves the workflow once with an explicit total budget bound to the workflow version, step listings, recipients and per-step maxima. The controller treats this as a set of bounded grants; any step whose quote differs (price, recipient, mint, listing version) stops the run for a fresh approval. Agents may propose a workflow but cannot widen its budget.
- **Execution.** Steps run in order under the controller. A step starts only after the previous step's deliverable is validated and stored. Step outputs pass to later steps only as stored artifacts mapped by the definition; output text is untrusted and never becomes an instruction or permission. A failed or uncertain step stops the run with every completed step still visibly paid; later steps are not bought.
- **External effects.** Read-only tools are the default. Any step that publishes, schedules or posts externally (for example Zernio) produces a draft, and the owner approves the exact content, account and time before it is sent. Nothing is posted automatically.
- **Connectors.** Tool listings wrap a provider's official API or MCP server on the seller host, with a pinned tool manifest; a changed upstream manifest disables the listing until re-reviewed. Provider credentials stay on the seller host. Provider costs are operator- or seller-funded and labeled; devnet test tokens do not pay providers.
- **Acceptance.** A workflow version cannot reference an unpublished or superseded listing; one owner approval cannot pay more than its total or a step more than its maximum; a changed step quote halts the run; each paid step has its own receipt and earnings event; a mid-run failure leaves earlier steps paid and later steps unbought; no publishing step sends without the owner's content-bound approval.

### 26.8 Demo inference model (v3.3)

The operator's demo budget is small, so inference uses an inexpensive pinned OpenRouter model. The pinned default is `deepseek/deepseek-v4-flash` (pinned 2026-10-17 at 91,000 / 182,000 pico-USD per prompt / completion token). The gateway still refuses a call whose live price exceeds the pin, and the operator ceiling caps total real spend. A free model may replace it only if its rate limits fit the demo and it is pinned the same way.


---

# Part II — Exact CLAUDE.md content

Extract the following block verbatim into CLAUDE.md at the build repository root. This is the repository policy, not an explanatory source comment.

````markdown
# CLAUDE.md

## Project

Build Veilo as a Solana-devnet multi-agent workspace with a real ZK private pool, standard x402 payments, independent spending controls, durable recovery and useful agent outputs. Read the repository PRD_latest.md before implementation. Requirements describe intended behavior, not shipped features.

## Git identity

- Never use Claude, Anthropic, an AI bot or an invented identity as commit author or committer.
- Use the human Git identity already configured for the repository. Do not change user.name, user.email, author/committer environment variables or existing attribution.
- Do not add Co-authored-by: Claude, AI co-author trailers or generated-by-AI commit text.
- If human identity is missing, finish the reviewable changes and report the missing identity before committing. Never fabricate one.
- Do not rewrite history, amend another person's commit, force-push or publish without the applicable user authorization.

## Comments

- Write comments only when they clarify an invariant, non-obvious behavior or a necessary constraint.
- Keep comments short, accurate and specific to this codebase. Do not narrate obvious code.
- Do not mention external planning documents, reference projects, this conversation, implementation tasks or AI generation in explanatory source comments.
- Explain what the code guarantees or why an edge case matters. Do not claim safety, privacy or performance beyond what the implementation proves.
- Keep architectural context in documentation. Keep reference attribution in README, NOTICE and license files; preserve legally required notices in reused code.

## Commits and branches

- Use Conventional Commits: type(scope): concise imperative description.
- Allowed types: feat, fix, refactor, test, docs, chore, build, ci, perf, revert.
- Example: feat(wallet): reserve task budgets atomically.
- Add BREAKING CHANGE details only for an actual incompatible public behavior change.
- Keep each commit focused and include the verification relevant to that change.
- Use branch names type/short-kebab-description, matching the same type vocabulary.
- Examples: feat/private-pool, fix/payment-reconciliation, docs/setup-guide.
- Avoid spaces, agent names, version hype or unspecified random identifiers in branch names.
- Inspect current branch and worktree before creating a branch. Do not discard existing changes or move unrelated work.

## Build discipline

- Implement the mandatory backlog in dependency order. A runnable private payment comes before expanding the dashboard.
- Preserve real on-chain proof verification. Never replace it with a database permission, mocked verifier or address rotation and call it private.
- Keep devnet identity and mint checks fail-closed. Never fall back to mainnet.
- Keep model tools away from notes, signing keys, provider credentials and policy mutation.
- Use integer financial units, atomic reservations, durable operation IDs and reconciliation for uncertain outcomes.
- Keep shared service credits and direct USDC payments distinct. Do not implement separate task credit buckets.
- Never expose seeds, keypair bytes, encrypted-note decryption secrets or API keys in output, logs, Git or screenshots.
- Run meaningful tests for modified financial/security behavior. Do not weaken checks, vectors or assertions to make tests pass.
- Label fixtures, sponsored inference and unverified behavior accurately. Report a measured blocker instead of silently removing a core requirement.
- Preserve source-license notices and reference attribution in project documentation.

## Completion

A feature is complete only when its relevant acceptance tests pass and its end-to-end behavior is demonstrated. Report what changed, what was verified and what remains blocked. A successful requirements review is not an audit or a deployment.
````

---

# Part III — Implementation task

# Veilo implementation task

Build Veilo end to end from Part I of this PRD_latest.md (version 3.1) and follow the CLAUDE.md policy in Part II. This document is an implementation contract, not existing software. Put PRD_latest.md at the implementation repository root and extract Part II into root CLAUDE.md before coding. Do not initialize or commit the entire parent Documents/Codex folder.

Start with T00: inspect existing repository/worktree and instructions, preserve user changes, install the supplied CLAUDE.md at the repository root, inspect human Git identity, and choose a conventional branch only if needed. Use that configured human identity for authorized commits. Never use Claude/AI authorship or AI co-author trailers. Comments must be concise, true and about the local code, without references to external planning documents or reference projects.

Then follow T01–T16 and their dependencies. Implement a real Solana devnet private pool with matching BN254 proof artifacts, a constrained owner wallet service, ordinary x402 merchant payments, a durable gateway backed by separately funded OpenRouter, and three agent roles: Shawn (shared credit replenishment), Prince (research), Mira (direct-USDC content purchase, drafts and calendar).

Retain the agreed architecture: one shared pool, fresh payment wallets, one shared gateway credit account for the replenishment scenario. Do not implement task credit buckets, external publishing, trading, physical commerce, mainnet fallback or mock privacy. Off-chain caps must remain honestly described as off-chain enforcement.

Preserve the MIT/third-party notices and document architectural lineage, but do not copy Cardano scripts/proving keys into Solana or call original test evidence Veilo evidence.

A funded setup keypair already exists in this chat workspace at work/keys/veilo-devnet-funding.json. It is not included in the deliverable package and will not automatically exist in a new checkout. The public address is 3FCio7smQJX7fm5x4Rz2UPPesfHA46FkexC3S3SqkMFd. Locate it through explicit local configuration; do not print, upload, regenerate or commit it. Do not use its private-key file as a privacy-pool address. Verify devnet balances before any transaction.

The ordinary x402 leg was tested: 0.01 devnet USDC to PayAI Echo, protected content returned, full refund finalized. Read Part IV for signatures and package versions. This verifies neither the privacy pool nor OpenRouter. Build M1/M2 before expanding agent UI.

Missing OpenRouter credentials or organizer clarification do not prevent scaffolding, contracts, circuit/local tests, SDK and gateway fixture tests. Live inference requires a locally supplied restricted credential and explicit real-spend ceiling. Do not buy real provider credits, change provider billing or infer a commercial allowance from test-USDC limits. No public publishing is authorized by this task.

Deliver source, commands, migrations, secret-free manifests, passing meaningful tests, real devnet transaction evidence, useful research/content output, backup/restore instructions, README, architecture and security documents. Maintain docs/build-status.md with task state and evidence. Finish independent work before reporting a narrow blocker. Never claim production readiness, guaranteed anonymity, PMF or competition eligibility from prototype evidence alone.


---

# Part IV — Verified devnet x402 payment evidence

# Verified devnet USDC x402 demo route

Date: October 14, 2026. Scope: actual ordinary x402 V2 payment and refund, not a private-pool or inference test.

## Result

Paid 0.01 devnet USDC (10,000 base units) from Veilo's funded setup wallet to PayAI's Echo Merchant. Received HTTP 200 and the protected resource. Independently fetched both payment and refund transactions through Solana devnet RPC: finalized, no on-chain errors, matching transferChecked mint and amount in both directions. Merchant refunded the full 0.01 test USDC.

- Wallet: 3FCio7smQJX7fm5x4Rz2UPPesfHA46FkexC3S3SqkMFd.
- Merchant: 8sqyMHQwBh8BCXC99pdgt6BpXwLu9xqfL1hDV5SFYf3R.
- Mint: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU (six decimals).
- Network: solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1.
- Scheme: exact, x402Version 2.
- Protected URL: https://x402.payai.network/api/solana-devnet/paid-content.
- Facilitator: https://facilitator.payai.network.
- [Finalized payment](https://explorer.solana.com/tx/5Br4iPZQWqnc4WxxFDSbnTxkNaDYgcxax3T8VHo6FF8YzryiEZ9zXMEvSzWVmM4zScGjCSa37qKtYHY2BtQDuNvB?cluster=devnet), slot 510976967.
- [Finalized refund](https://explorer.solana.com/tx/W8WnBPng78B8FXswy3TfRryEBwTykqihB1SuDzGCsya95XFooST3nJVYuadGvKEQbMxXGz1TeyaTeeqwts6B9EU?cluster=devnet), slot 510976975.

Client authorized one payment only, with an exact recipient/network/mint allowlist and 0.01 test-USDC ceiling. No mainnet funds or provider credentials were used. This test used the setup wallet directly and provides no payer privacy; it verifies the standard merchant leg needed after a future private withdrawal.

## Recommended Veilo content flow

Mira requests a bounded content-generation job from our gateway. Gateway returns an immutable x402 devnet requirement. Owner-controlled wallet checks policy, obtains real proof-funded fresh-wallet USDC from the deployed privacy pool, and signs a standard SVM exact merchant payment. PayAI verifies/settles that merchant leg. Gateway checks finality and idempotency, invokes its separately funded OpenRouter account, and returns drafts/calendar. The pool relayer and PayAI facilitator perform different jobs; PayAI does not verify Veilo's ZK withdrawal.

The Echo Merchant is a live payment smoke test, not an LLM provider. The custom gateway and OpenRouter adapter still need implementation and an operator credential. Real privacy still requires the pool program and circuit artifacts; neither is deployed by this test.

## Alternatives and fallback

Live capability reads also found x402 V2 exact Solana devnet support at https://facilitator.x402.rs/supported, but no settlement was tested there. A request to https://x402.org/facilitator/supported returned HTTP 403 in this environment; do not make it the demo dependency without a new check.

Self-hosted fallback: Solana Foundation Kora's documented x402 V2 devnet demo. Use its supported/configuration checks and own fee sponsor if managed PayAI availability or terms become unsuitable. Do not switch to mainnet automatically on managed-provider failure.

## Tested package versions

- @x402/core: 2.28.0
- @x402/fetch: 2.28.0
- @x402/svm: 2.28.0
- @solana/kit: 5.5.1

## Primary references

- [PayAI Echo Merchant](https://x402.payai.network/).
- [PayAI developer portal](https://payai.network/developers).
- [Solana x402 V2](https://solana.com/docs/payments/agentic-payments/x402).
- [Kora devnet facilitator guide](https://solana.com/docs/tools/kora/guides/x402).

Advertised capabilities and fee policies can change; startup rechecks /supported and enforces independent limits. This one successful payment demonstrates availability at test time, not a production SLA.


---

# Part V — Public funding-wallet setup

```text
Veilo development funding wallet
Network: Solana devnet only
Public address: 3FCio7smQJX7fm5x4Rz2UPPesfHA46FkexC3S3SqkMFd
Use this owner address for devnet SOL and test USDC faucets.
This is a local setup wallet, not a deployed pool address.
Do not send mainnet assets.
Private key remains locally in work/keys/veilo-devnet-funding.json (restricted permissions); do not upload or commit it.
```

These addresses and balances are public test-network facts, not instructions to send mainnet assets. The keypair is not included. Historical balances must be rechecked before deployment. The privacy pool address will be derived after real deployment and is not this setup wallet.

---
