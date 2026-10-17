# Specialist-agent marketplace

**Status: accepted scope, implementation pending in this checkout; end-to-end acceptance is not yet run.** PRD v3.2 §26 adds this marketplace to the existing private-wallet workspace. It does not remove the original payment, privacy or recovery requirements. [Marketplace triage](./marketplace-triage.md) records the code gaps and T17–T23 release gates.

## Buy work or offer a specialist

Owners create agents with their own names, instructions, triggers, tools and independently enforced budgets. The marketplace extends those agents with reviewed, fixed-price specialists. A buyer can hire manually, or let an agent discover and propose a specialist. A new seller still needs owner approval before payment. Models propose work; local control authorizes money.

The required first release includes:

| Buyer experience | Seller experience |
|---|---|
| Wallet sign-in and a searchable catalogue of reviewed listings | Self-service seller setup followed by operator review before publication |
| One specialist per hire, with an immutable fixed-price, fixed-scope quote | Direct settlement to the listing's verified seller recipient |
| Private job board, requests for missing inputs, downloadable deliverables and receipts | Assigned-job access and a history of finalized earnings receipts |
| Manual hiring or discovery within owner-approved permissions | Managed templates or reviewed remote endpoints, with read-only connectors by default |

These are requirements, not screens or endpoints available in the current application. The seeded six-SKU gateway catalogue is a local service catalogue; it is not the searchable seller marketplace. Generic templates are also pending: current execution is limited to credit-manager, research and content roles. Shawn, Prince and Mira become templates in T19 rather than defining the marketplace's full agent model.

## Two sign-ins, two responsibilities

The marketplace uses **Supabase Auth, Postgres and Storage** for accounts, catalogue, private jobs, artifact metadata and accounting projections. Each workspace retains one owner; multiple independent buyer/seller accounts do not create a shared multi-owner wallet.

Supabase Web3 sign-in establishes marketplace identity. The existing local wallet challenge establishes spending authority. A connected but unsigned wallet grants no private-data access, and a cloud session never authorizes a withdrawal. Cloud policy edits remain proposals until local control installs and acknowledges them.

Local control connects outbound using authenticated, digest-bound, expiring requests. It retains authority over policies, reservations and revocation; the local wallet retains notes, proofs and signing keys. Automatic spending pauses while local control is offline. The original T00–T16 local workspace must keep working without Supabase. There is no implemented cloud connection or Supabase setup command in this checkout yet.

<script setup>
import marketplace from '../diagrams/marketplace.mmd?raw'
</script>

<Diagram :source="marketplace" caption="Required marketplace boundaries. The cloud records jobs; local control authorizes spending; the seller receives ordinary public x402 settlement. This flow is not yet implemented end to end." />

## Direct seller payments and receipts

For a paid hire, an immutable quote names the reviewed listing and runtime versions, seller payout version, exact recipient, network, mint, amount and expiry. Local control rechecks approval and every applicable allowance. The wallet proves a pool withdrawal to a fresh signer, then validates an ordinary x402 V2 exact payment to that seller. Execution starts only after independently verified finality; an explicitly free quote may start without payment.

The platform fee is explicitly **zero** in each quote and receipt: `F = floor(B × r / 10000)`, with `r = 0`. Seller earnings are a history of settled chain receipts, not a withdrawable platform balance. The platform must not receive seller funds as an intermediate merchant.

The existing client supports approved per-service recipient bindings, but the Veilo gateway currently accepts its single configured merchant. **Managed paid listings remain blocked until per-listing recipients are implemented and verified.** A separately operated compliant seller endpoint is a possible integration path; live third-party seller payment and marketplace hiring have not been demonstrated. Gateway credits remain the existing service prepayment option and do not substitute for direct seller settlement.

Amounts are devnet test tokens, represented as integer base units and transported as decimal strings; quotes and receipts identify the exact network and mint. Job and financial events must be append-only, with unique operation, receipt and earnings constraints.

One receipt may fund exactly one job and produce one earnings event. Lost replies remain pending and must reconcile the same operation. A paid job that fails remains visibly paid. Refunds are separate seller-funded transfers to an owner-verified address, capped at the settled amount and counted only after finality; automatic refunds and escrow are deferred.

## Private data and honest privacy

The public catalogue must be a sanitized projection. Private jobs, inputs, receipts and files are available only to their authorized participants. Exposed tables require RLS and explicit grants. Clients cannot directly update quotes, jobs, payments or earnings; trusted transition APIs enforce state and actor checks. Storage buckets remain private, with short-lived signed download links. Service keys stay server-side.

The marketplace operator, seller, facilitator and model provider can see the buyer–seller relationship and plaintext job data they process. The pool targets only the explicit on-chain deposit-to-payment link. Amounts, fresh payment wallets and timing remain public; no metadata anonymity or anonymity score is promised. See [privacy](./privacy.md).

Hosted execution needs isolation and controlled network access without wallet secrets. The current local Node runner does not establish a hosted seller sandbox. Listing text, tool responses and result files are untrusted; they cannot expand permissions or execute scripts in the app origin.

## Required defaults and deferred scope

| Limit | v3.2 default |
|---|---|
| Active execution / tool calls | 10 minutes / 8 calls |
| Execution attempts | One attempt; retries cannot silently repeat payment or provider cost |
| Quote TTL | 5 minutes |
| Worker lease / heartbeat | 60 seconds / 15 seconds |
| Attachments | At most 10, each at most 20 MiB |
| Content retention | 30 days |
| Paid delegation depth | One specialist per hire; no paid recursive delegation |

These are marketplace requirements, not changes to the existing gateway's 600-second quote default or other local configuration. Deployment, enforcement, cleanup and timeout evidence remain outstanding.

Auctions, reputation, escrow, automatic refunds, arbitrary uploaded code/open code hosting, multi-seller bundles and nonzero fees are deferred. Read-only connector access is the default; external publishing is not authorized by a hire.

Before implementation or release, complete the [discovery, delivery and acceptance gates](./marketplace-triage.md). No pool-contract change is required solely for this marketplace extension.
