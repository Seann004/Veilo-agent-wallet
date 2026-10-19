# Specialist-agent marketplace

**Status: implemented in code on `main`; devnet acceptance is incomplete.** The marketplace extends the existing private-wallet workspace without removing the original payment, privacy or recovery requirements. Identity and data isolation pass the live RLS end-to-end script (84/84), and a direct hire with a **publicly funded** payer settled on Solana devnet. A hire funded from the private pool, a devnet workflow run and live refunds are **not yet run**. [Current status](./status.md) and [marketplace triage](./marketplace-triage.md) record the gates.

## Buy work or offer a specialist

Owners create agents with their own names, instructions, triggers, tools and independently enforced budgets. The marketplace extends those agents with reviewed, fixed-price specialists. A buyer can hire manually, or let an agent discover and propose a specialist. A new seller still needs owner approval before payment. Models propose work; local control authorizes money.

The required first release includes:

| Buyer experience | Seller experience |
|---|---|
| Wallet sign-in and a searchable catalogue of reviewed listings | Self-service seller setup followed by operator review before publication |
| One specialist per hire, with an immutable fixed-price, fixed-scope quote | Direct settlement to the listing's verified seller recipient |
| Private job board, requests for missing inputs, downloadable deliverables and receipts | Assigned-job access and a history of finalized earnings receipts |
| Manual hiring or discovery within owner-approved permissions | Managed templates or reviewed remote endpoints, with read-only connectors by default |

In the dashboard, the open marketplace lives under `/marketplace`: workflows (`/marketplace`, `/marketplace/w/<slug>`, categories at `/marketplace/c/<category>`), the five-step builder (`/marketplace/create`), the tool library (`/marketplace/tools`), runs, specialists, private jobs, the seller console, agent pages and the **Local approval** page (`/marketplace/approvals`). Role templates for the workspace's own agents are listed in the marketplace too; the old `/market` address redirects to `/marketplace`. `/connectors` manages read-only MCP connectors for agents, including CoinGecko market data (`coingecko-market`, templated tools; not yet seeded live) and result destinations.

Execution supports the credit-manager, research and content roles plus a `custom` role with `marketplace_search` and `propose_hire` tools. Custom agents do the work themselves on the owner's model key and propose a hire or an assigned workflow run only when outside help is needed; a reference image's style is included in the hire brief. There is no free (zero-price) job path yet; every listing is paid.

## Two sign-ins, two responsibilities

The marketplace uses **Supabase Auth, Postgres and Storage** for accounts, catalogue, private jobs, artifact metadata and accounting projections. Each workspace retains one owner; multiple independent buyer/seller accounts do not create a shared multi-owner wallet.

Supabase Web3 sign-in establishes marketplace identity. The existing local wallet challenge establishes spending authority. A connected but unsigned wallet grants no private-data access, and a cloud session never authorizes a withdrawal. Cloud policy edits remain proposals until local control installs and acknowledges them.

Local control connects outbound using authenticated, digest-bound, expiring requests. It retains authority over policies, reservations and revocation; the local wallet retains notes, proofs and signing keys. Automatic spending pauses while local control is offline. The original T00–T16 local workspace keeps working without Supabase: `pnpm dev` starts the marketplace service and seller host only when `SUPABASE_URL` (and, for the seller host, `MARKETPLACE_SELLER_HOST_TOKEN_PATH`) is set. Variables are in [configuration](../configuration.md).

<script setup>
import marketplace from '../diagrams/marketplace.mmd?raw'
</script>

<Diagram :source="marketplace" caption="Required marketplace boundaries. The cloud records jobs; local control authorizes spending; the seller receives ordinary public x402 settlement. A private-pool-funded hire through this flow is not yet run on devnet." />

## Direct seller payments and receipts

For a paid hire, an immutable quote names the reviewed listing and runtime versions, seller payout version, exact recipient, network, mint, amount and expiry. Local control rechecks approval and every applicable allowance. The wallet proves a pool withdrawal to a fresh signer, then validates an ordinary x402 V2 exact payment to that seller. Execution starts only after independently verified finality; an explicitly free quote may start without payment.

The platform fee is explicitly **zero** in each quote and receipt: `F = floor(B × r / 10000)`, with `r = 0`. Seller earnings are a history of settled chain receipts, not a withdrawable platform balance. The platform must not receive seller funds as an intermediate merchant.

Managed listings run on the gateway's seller-host profile, which settles to each listing's verified payout address rather than the workspace gateway merchant. Two devnet smokes recorded a direct 10,000-base-unit payment to the seller's payout ATA, a chain-verified receipt, one succeeded job and earnings with a zero fee; their payer was funded publicly, not from the pool. A private-pool-funded hire and a third-party remote seller job are **not yet run** on devnet. Gateway credits remain the workspace's service prepayment option and do not substitute for direct seller settlement.

Amounts are USDC on Solana devnet, represented as integer base units and transported as decimal strings; quotes and receipts identify the exact network and mint. Job and financial events must be append-only, with unique operation, receipt and earnings constraints.

One receipt may fund exactly one job and produce one earnings event. Lost replies remain pending and must reconcile the same operation. A paid job that fails remains visibly paid. Refunds are separate seller-funded transfers to an owner-verified address, capped at the settled amount and counted only after finality; automatic refunds and escrow are deferred.

## Private data and honest privacy

The public catalogue must be a sanitized projection. Private jobs, inputs, receipts and files are available only to their authorized participants. Exposed tables require RLS and explicit grants. Clients cannot directly update quotes, jobs, payments or earnings; trusted transition APIs enforce state and actor checks. Storage buckets remain private, with short-lived signed download links. Service keys stay server-side.

The marketplace operator, seller, facilitator and model provider can see the buyer–seller relationship and plaintext job data they process. The pool targets only the explicit on-chain deposit-to-payment link. Amounts, fresh payment wallets and timing remain public; no metadata anonymity or anonymity score is promised. See [privacy](./privacy.md).

Hosted execution needs isolation and controlled network access without wallet secrets. Neither the local Node runner nor the seller host establishes a hosted seller sandbox. Listing text, tool responses and result files are untrusted; they cannot expand permissions or execute scripts in the app origin.

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

These are marketplace requirements, not changes to the existing gateway's 600-second quote default. `MARKETPLACE_QUOTE_TTL_SECONDS` is configured separately (see [configuration](../configuration.md)). Content-retention cleanup is not implemented, and timeout evidence remains outstanding.

Auctions, reputation, escrow, automatic refunds, arbitrary uploaded code/open code hosting, multi-seller bundles and nonzero fees are deferred. Read-only connector access is the default; external publishing is not authorized by a hire. The one exception is a seller's own opt-in: a seller host with `ZERNIO_PUBLISH_MODE=publish` can post a carousel publicly to that seller's TikTok account as a listed workflow step (unverified live).

Before release, close the remaining [delivery and acceptance gates](./marketplace-triage.md). No pool-contract change is required solely for this marketplace extension.
