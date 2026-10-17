# Architecture

**Verification scope:** see [current status](./status.md). M2 only is **verified on devnet**; integrated flows are **verified on local test validator** with a **fixture / mock provider**. The integrated devnet agent demo is **not yet run**.

Veilo separates agent planning, financial authority, public-chain enforcement and paid-service delivery. The deployment model is single-owner and local, with distinct processes, credentials and secret access. These are application/process credential boundaries on a trusted owner host, not an OS sandbox against a compromised process. Owners can create and configure agents; demo agents are examples of roles running within the same authority boundaries.

## The architecture in plain language

The owner defines the job and spending rules. The **agent runner** decides what resources would help. The **control service** checks limits and reserves the budget. The **wallet service** holds private notes, generates proofs and signs only allowed payments. The **pool program** verifies the withdrawal on chain. A fresh wallet then makes a normal **x402** payment, and the **gateway** delivers the purchased service.

This separates decision-making from financial authority: a model proposing a purchase cannot grant itself permission to spend. The owner sees agent-level activity locally, while the public payment path avoids publishing those agent identifiers.

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
| Control service | Policies, scheduler, atomic reservations, audit events, revocation epochs | Single authority for workspace/agent/task spending allowances |
| Agent runner | Bounded planning, catalog selection, requesting purchases, saving outputs | No note database, provider key, arbitrary signer or policy mutation |
| Wallet service | Encrypted notes, local proofs, constrained fresh-wallet signing, recovery | Checks current policy before releasing financial authority |
| Relayer / indexer | Sponsor permitted chain costs, submit withdrawals, rebuild public tree state | Does not receive note secrets; indexer cannot invent accepted roots |
| Privacy pool program | Verify proofs, conserve value, consume nullifiers, enforce bound destinations and owner exits | On-chain enforcement; PDA controls the SPL vault |
| Service gateway | Immutable quotes, settlement reconciliation, durable credits, delivery/result cache | Merchant is the gateway operator; credits stay linked to an authenticated workspace |
| x402 facilitator | Verify and settle standard exact SVM payment | Merchant leg only; distinct from the private-withdrawal relayer |
| OpenRouter / data adapter | Bounded real inference or explicitly labeled research data | Provider availability and commercial funding are operator dependencies |

## Implemented stack and source layout

TypeScript, Next.js dashboard, Express gateway, durable workers, SQLite WAL, Rust/Anchor pool program and Circom/snarkjs BN254 Groth16 proofs. Versions are pinned in lockfiles and proof artifacts in `artifacts/circuits/manifest.json`; see [deployment](../deployment.md).

| Source path | Contents |
|---|---|
| `apps/dashboard/` | Owner UI and same-origin proxy to the control API |
| `services/control/`, `services/runner/` | Policy, reservations, scheduler and restricted workers |
| `services/wallet/`, `services/relayer/` | Private state, signing, proofs and public chain adapters |
| `services/gateway/` | x402 routes, credit ledger and provider adapters |
| `packages/contracts/`, `packages/db/` | Shared schemas, migrations and durable state |
| `packages/privacy-sdk/`, `packages/x402-client/` | Witness/encoding logic and constrained payment adapter |
| `programs/privacy-pool/`, `circuits/` | On-chain program and spend/insert/exit circuits |
| `tests/`, `scripts/`, `artifacts/` | Acceptance tests, operator commands and public artifact manifests |

These paths exist in the source snapshot. Documentation has its own dependency manifest and lockfile under `docs/`. The funded dashboard/browser-wallet flow remains **not yet run**; local UI checks are recorded separately in build status T14.

## Enforcement placement

The chain/proofs enforce ownership, approved-set membership for private spends, value conservation, nullifier uniqueness, withdrawal intent and owner exit. The wallet/control service enforces budgets, merchant selection, revocation and signing policy. The gateway enforces paid delivery, credit issuance/debit, request binding and provider cost limits. The model is not a security authority.

Off-chain spending caps are not proof-enforced caps. Compromise of the owner wallet service can bypass its local policy and expose its notes.

## Durable state

Control owns scoped allowance reservations; the gateway owns issued/reserved/consumed credits. Link operations across these databases with stable operation IDs and durable outbox/inbox events. Do not maintain two independently authoritative copies of the gateway balance.

Keep encrypted notes and signer/provider secrets separate from runner-readable activity. A restart must reconcile released proofs, signed transactions and provider attempts before creating new financial authority. See [payments](./payments.md) and [policy](./policy.md).
