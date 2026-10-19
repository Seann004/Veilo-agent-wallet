# Architecture

**Verification scope:** see [current status](./status.md). The recorded M2 proof run is **verified on devnet**; integrated flows are **verified on local test validator** with a **fixture / mock provider**. The Shawn/Prince/Mira demo has one recorded pre-merge **verified on devnet** run with live inference. Marketplace code is on `main`; a private-pool-funded hire is **not yet run** on devnet.

Veilo separates agent planning, financial authority, public-chain enforcement and paid-service delivery. The implemented owner stack is local, with one owner per workspace and distinct processes, credentials and secret access. The accepted v3.2 marketplace adds multiple independent buyer/seller accounts and cloud product records; it does not make a workspace multi-owner. These are application/process credential boundaries on a trusted owner host, not an OS sandbox against a compromised process. Owners can create and configure agents; demo agents are examples of roles running within the same authority boundaries.

## The architecture in plain language

The owner defines the job and spending rules. The **agent runner** decides what resources would help. The **control service** checks limits and reserves the budget. The **wallet service** holds private notes, generates proofs and signs only allowed payments. The **pool program** verifies the withdrawal on chain. A fresh wallet then makes a normal **x402** payment, and the **gateway** delivers the purchased service.

This separates decision-making from financial authority: a model proposing a purchase cannot grant itself permission to spend. The owner sees agent-level activity locally, while the public payment path avoids publishing those agent identifiers.

### Connected wallet, local wallet service and fresh payment wallet

These are three different parts of the payment flow:

| Part | Role |
|---|---|
| Owner's connected wallet, such as Phantom | Signs the owner's deposit into the pool and owner withdrawals; it does not store Veilo's note secrets. |
| Veilo local wallet service | Stores encrypted pool notes and fresh-wallet signing material in its separate local secrets database, builds proofs and signs permitted payments. |
| Fresh payment wallet | A per-purchase Solana address that receives the pool payout and pays the merchant. Pool note secrets stay in the local wallet service. |

A **note** is a private record of a claim to funds in the pool. It contains a value, a protocol label and two secret field elements (`noteSecret` and `nullifierSecret`). The USDC itself is held in the pool's on-chain vault; a cryptographic commitment represents the note in the pool's state tree. The local service's encryption and note derivation use its owner-service secret, not the connected wallet's seed phrase.

For example, ignoring separate fees, a 10 USDC note can authorize a 3 USDC payout to a fresh payment wallet and a new 7 USDC change note. The original note is consumed; the change note uses fresh secrets and becomes spendable after insertion and the required approval/state checks. The next purchase uses another fresh payment wallet. Deposit and payout amounts, payment addresses, merchant transfers and timing remain public; the proof avoids publishing the particular spent deposit commitment as a public input. See [privacy](./privacy.md) for correlation limits and [configuration](../configuration.md) for secret storage.

<script setup>
import architecture from '../diagrams/architecture.mmd?raw'
import funding from '../diagrams/private-funding.mmd?raw'
import delivery from '../diagrams/service-delivery.mmd?raw'
</script>

## 1. Agent authorization

<Diagram :source="architecture" caption="The agent requests resources; owner-controlled services authorize and record spending." />

## 2. Private funding and public settlement

<Diagram :source="funding" caption="The pool verifies the private withdrawal. The fresh wallet’s merchant payment remains public." />

## 3. Paid service delivery

<Diagram :source="delivery" caption="The gateway reconciles settlement and delivers the purchased service or issues shared credits." />

## Components and authority

| Component | Responsibility | Boundary |
|---|---|---|
| Owner dashboard | Wallet session, agent configuration, approvals, monitoring | Authenticated UI; never asks for the owner's seed phrase |
| Control service | Policies, scheduler, atomic reservations, audit events, revocation epochs; the owner's sealed model key and model calls; browse permits; connector calls; result delivery; swap approval | Single authority for workspace/agent/task spending allowances; agents receive completions and fenced data, never keys |
| Agent runner | Bounded planning, catalog selection, requesting purchases, reading permitted public pages in a cookie-less Chrome context, saving outputs | No note database, provider key, reference image, arbitrary signer or policy mutation |
| Wallet service | Encrypted notes, local proofs, constrained fresh-wallet signing, recovery | Checks current policy before releasing financial authority |
| Relayer / indexer | Sponsor permitted chain costs, submit withdrawals, co-sign the one permitted devnet swap shape, rebuild public tree state | Does not receive note secrets; indexer cannot invent accepted roots |
| Privacy pool program | Verify proofs, conserve value, consume nullifiers, enforce bound destinations and owner exits | On-chain enforcement; PDA controls the SPL vault |
| Service gateway | Immutable quotes, settlement reconciliation, durable credits, delivery/result cache | Merchant is the gateway operator; credits stay linked to an authenticated workspace |
| x402 facilitator | Verify and settle standard exact SVM payment | Merchant leg only; distinct from the private-withdrawal relayer |
| Owner's model provider | Planning, analysis, content and reference-image style, called by control with the owner's key | Billed to the owner; sees prompts, gathered data and the reference image |
| OpenRouter / data adapter | Operator-sponsored planning trial, paid inference SKUs or explicitly labeled research data | Provider availability and commercial funding are operator dependencies |
| MCP connector servers | Read-only tools pinned by digest; CoinGecko market data through Veilo templates | Third-party text, fenced as untrusted; servers see the requested arguments |
| Orca whirlpool (devnet) | USDC to SOL for an owner-approved swap from a fresh wallet | One pinned pool; devnet prices are not market prices |

## Implemented stack and source layout

TypeScript, Next.js dashboard, Express gateway, durable workers, SQLite WAL, Rust/Anchor pool program and Circom/snarkjs BN254 Groth16 proofs. Versions are pinned in lockfiles and proof artifacts in `artifacts/circuits/manifest.json`; see [deployment](../deployment.md).

| Source path | Contents |
|---|---|
| `apps/dashboard/` | Landing page, owner/guest/public-view workspace, marketplace pages and same-origin proxy to the control API |
| `services/control/`, `services/runner/` | Policy, reservations, scheduler and restricted workers |
| `services/wallet/`, `services/relayer/` | Private state, signing, proofs and public chain adapters |
| `services/gateway/` | x402 routes, credit ledger and provider adapters; also the seller-host profile for marketplace jobs |
| `services/marketplace/`, `supabase/migrations/` | Marketplace API over Supabase Auth/Postgres/Storage and its schema/RLS |
| `packages/contracts/`, `packages/db/`, `packages/mcp-client/` | Shared schemas, migrations, durable state and the read-only MCP client |
| `packages/privacy-sdk/`, `packages/x402-client/` | Witness/encoding logic and constrained payment adapter |
| `programs/privacy-pool/`, `circuits/` | On-chain program and spend/insert/exit circuits |
| `tests/`, `scripts/`, `artifacts/` | Acceptance tests, operator commands and public artifact manifests |

These paths exist in the source snapshot. Documentation has its own dependency manifest and lockfile under `docs/`. The funded dashboard/browser-wallet flow remains **not yet run**; local UI checks are recorded separately in build status T14. The dashboard (`apps/dashboard`) serves a public landing page at `/`, the owner workspace at `/workspace` and the open marketplace under `/marketplace`.

## Marketplace extension

`services/marketplace` uses Supabase Auth, Postgres and private Storage for marketplace identity, catalogue, jobs, artifact metadata and accounting projections (19 migrations under `supabase/migrations/`). Local control retains policies/reservations/revocation and local wallet retains secrets/proofs/signing. The cloud never becomes a spending authority. It receives acknowledged state through an outbound, authenticated, digest-bound and expiring connection initiated by local control. Spending pauses while control is offline.

Marketplace Web3 sign-in and the existing local wallet challenge are deliberately separate. The local P0 stack still works without Supabase. Seller settlement goes directly to the reviewed recipient: managed listings run on the gateway's seller-host profile (`GATEWAY_ROLE=seller-host`), which pays the listing's payout address, not the operator merchant. No pool-contract change is needed solely for the extension. See the [marketplace boundary diagram](./marketplace.md) and [source-based triage](./marketplace-triage.md).

## Enforcement placement

The chain/proofs enforce ownership, approved-set membership for private spends, value conservation, nullifier uniqueness, withdrawal intent and owner exit. The wallet/control service enforces budgets, merchant selection, revocation and signing policy. The gateway enforces paid delivery, credit issuance/debit, request binding and provider cost limits. The model is not a security authority.

The devnet swap is enforced at three points: control (owner approval, maximum per swap, caps), the wallet (decodes the quoted swap before signing) and the relayer (accepts only the exact five-instruction transaction). See [payments](./payments.md#devnet-swap).

Off-chain spending caps are not proof-enforced caps. Compromise of the owner wallet service can bypass its local policy and expose its notes.

## Durable state

Control owns scoped allowance reservations; the gateway owns issued/reserved/consumed credits. Link operations across these databases with stable operation IDs and durable outbox/inbox events. Do not maintain two independently authoritative copies of the gateway balance.

Keep encrypted notes and signer/provider secrets separate from runner-readable activity. A restart must reconcile released proofs, signed transactions and provider attempts before creating new financial authority. See [payments](./payments.md) and [policy](./policy.md).
