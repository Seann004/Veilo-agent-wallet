# Veilo: presentation content and speaker notes for owner review

Reviewed with GPT-6 Astra at low reasoning effort against the exact Topic F statement supplied by the owner on 19 October 2026. This replaces the earlier budget-first proposal. This is the canonical presentation-content proposal, pending owner approval. The existing PowerPoint remains an earlier draft and must be rebuilt only after content approval. There is no demo slide or embedded demo segment.

## Exact organizer statement

> Autonomous On-chain Wallet: The track’s signature topic — build an AI wallet agent that autonomously executes on-chain operations (asset management, transaction execution, risk control). Ambitious ideas are encouraged, with a 0–5 point challenge bonus.

This is the supplied statement, not an independently verified competition page. It does not establish devnet eligibility or reuse acceptance. Bonus points are discretionary and no score is predicted.

## Narrative and timing

Veilo is a personal agent workspace, private on-chain funding wallet and marketplace. Audience: individuals, builders and business owners. Wallet execution is the core Topic F connection. Spending controls support the product rather than define it.

12 slides, target speaking time **5 minutes 40 seconds**. A website demonstration is separate. Rehearse the complete session below the organizer's ten-minute presentation maximum if showing the website during the presentation slot.

## 1. Veilo (0:15)

**On slide**

**Your personal agent workspace, with private on-chain funding and a marketplace**

Create agents. Fund their work. Hire specialists and run workflows.

Footer: Solana devnet prototype.

**Speaker notes**

“Veilo brings personal AI agents, an on-chain wallet and a marketplace into one workspace. Owners give agents jobs and permission to acquire the tools or specialist help they need, using private pool funding.”

## 2. Who it is for (0:25)

**On slide**

- Individuals who want personal agents to get work done.
- Builders connecting agents to tools and on-chain payments.
- Business owners delegating work and hiring specialists.

Shared need: useful automation, payment privacy and owner control.

**Speaker notes**

“Our intended users include individuals, builders and business owners. An agent needs more than a conversation to complete work: it needs access to resources, a way to pay and sometimes specialist help. Owners need visibility and control without manually coordinating every step.”

These are intended audiences, not claimed customer traction.

## 3. Our solution (0:25)

**On slide**

**Personal agent workspace + private on-chain wallet + marketplace**

Describe the outcome, authorize the work, and let agents coordinate permitted tools, specialists and payments.

Review the results and spending in one place.

**Speaker notes**

“The workspace is where you create and direct agents. The wallet funds approved on-chain actions through the private pool. The marketplace supplies specialists and reusable workflows. Together they connect a task to the resources, payments and outputs needed to complete it.”

Do not imply that the entire workspace, prompts or marketplace relationship is cryptographically private.

## 4. Features (0:30)

**On slide**

- Personal agents with configurable instructions and tools.
- Private pool funding and on-chain service payments.
- Marketplace specialists and multi-step workflows.
- Automated hiring within explicit owner grants.
- MCP connectors, browsing and owner spending controls.

Footnote: Components implemented; current end-to-end verification varies.

**Speaker notes**

“Owners can configure agents, connect read-only tools and discover specialists or workflows. Hiring requires local approval or an explicit listing grant. Within a grant, an agent can request the permitted hire without repeating every approval. It cannot create its own spending authority. Private-funded marketplace hiring still needs its current devnet acceptance run.”

Sources: docs/guide/agents.md; docs/guide/marketplace.md; docs/guide/status.md. Keep pause, revoke, monitoring and recovery available in the supporting product explanation.

## 5. Autonomous on-chain operations (0:30)

**On slide**

- **Asset management:** shared funding, agent allowances and tracked exposure.
- **Transaction execution:** proof-authorized withdrawals and x402 settlement.
- **Risk control:** caps, approved recipients, expiry, revoke and replay protection.

Designed for autonomous execution within owner-defined permissions.

**Speaker notes**

“This directly addresses the Autonomous On-chain Wallet topic. Asset management here means allocating allowances and tracking funds and exposure, not claiming portfolio optimization. Transaction execution connects pool withdrawals to seller payment. Risk controls decide which actions are permitted. Triggered replenishment is implemented, but a manual trigger does not prove unattended initiation.”

The marketplace and useful agent workflows explain implementation ambition. The 0–5 challenge bonus is an organizer decision and is not a promised outcome.

## 6. Technical architecture (0:35)

**On slide**

Agent proposes → control checks and reserves → wallet proves and signs → Solana pool verifies → fresh wallet pays → seller delivers.

**The model cannot grant itself spending authority.**

**Speaker notes**

“Control checks permissions and reserves the budget atomically. The wallet protects the private notes, generates the proof locally and validates the transaction before signing. The pool verifies the proof on Solana and funds a fresh payout wallet. That wallet settles with the seller through standard x402. Marketplace identity records are separate from local signing authority.”

Sources: docs/guide/architecture.md; docs/guide/policy.md. Budgets and revocation are owner-service controls, not cryptographic spending caps. The Orca swap path is separate from x402 merchant settlement.

## 7. How private funding works (0:35)

**On slide**

- Commit a deposit note to the shared pool.
- Prove control of an eligible note without naming the spent deposit.
- Use a nullifier to prevent double spending.
- Fund a fresh payout wallet and retain private change.

**Public:** amounts, merchant payments and timing. Small pools give weak privacy.

**Speaker notes**

“The proof removes the explicit spent-deposit identifier from the withdrawal. Its intent binds the payout, and a nullifier stops the same note being spent twice. The merchant payment remains an ordinary public transaction. Distinctive amounts and timing can still correlate activity. Sellers and providers see the jobs they process, and the owner retains local attribution.”

Sources: docs/guide/privacy.md; docs/protocol.md. Do not describe ordinary wallet rotation or public x402 alone as the private mechanism. Credit zx402 as architectural inspiration in the notes and source attribution.

## 8. Technology stack (0:30)

**On slide**

- **Interface and services:** Next.js, TypeScript and Express.
- **Local durable state:** SQLite.
- **On-chain program:** Solana, Rust and Anchor.
- **Privacy proofs:** Circom, snarkjs and Groth16.
- **Marketplace:** Supabase identity, database and storage.
- **Integrations:** x402 service payments and MCP connectors.

**Speaker notes**

“The stack separates the interface, durable state, financial authority and on-chain verification. Supabase supports marketplace identity and records, while local control and wallet retain spending authority. The owner host is trusted. Current proving setup and deployment are for devnet, and this is not an externally audited system.”

Source: docs/guide/architecture.md. This is a role-based stack overview, not a list of claims that every integration has a live paid run.

## 9. Evidence and current limits (0:30)

**On slide**

- Recorded devnet proof withdrawals, x402 payments and public exits.
- Reviewed local tree: **994 tests passed, 1 skipped**.
- Fresh evidence still needed for unattended initiation, the hardened swap path and private-funded marketplace hiring.

**Devnet only. Unaudited. Development trusted setup.**

**Speaker notes**

“Historical receipts establish real recorded transactions. The reviewed local tree, source b155f17, based on main 55e6404 plus the submission fixes, passed 994 tests with one skipped across 127 files. That does not retroactively move older receipts onto the current code. Current swap and marketplace paths still need new execution evidence. Sponsor and fee-accounting gaps remain documented.”

Sources: docs/submission-review-2026-10-19.md; docs/guide/status.md; artifacts/evidence. Attach the final tested revision before submission. Change the evidence wording only after a reviewed finalized receipt exists.

## 10. Intended impact (0:25)

**On slide**

- Owners coordinate work through personal agents.
- Agents access specialists and tools within granted authority.
- Owners retain spending visibility and control.
- Pool funding reduces explicit public deposit-to-payment linkage.

**Speaker notes**

“The intended impact is connecting delegated work to the resources and payments it needs. An individual can organize personal tasks, a builder can connect agent services, and a business owner can coordinate specialist work. We aim to reduce manual coordination while retaining accountability. These are benefits to validate, not measured time savings, user adoption or revenue.”

Do not use invented market size, customers, cost savings or productivity statistics.

## 11. Proposed business model (0:25)

**On slide**

- Workspace subscriptions for advanced agent and team operations.
- Optional managed infrastructure and support.
- Potential marketplace revenue share as the ecosystem develops.

**Current platform fee: zero. Pricing and demand need validation.**

**Speaker notes**

“These are business-model proposals. Individuals could begin with a personal workspace, while builders and businesses could pay for advanced operational features or managed support. We could later explore marketplace revenue share. Current code enforces a zero platform fee. Seller prices, provider credits and network charges are separate, and we have not established willingness to pay or unit economics.”

Source for current fee: packages/contracts/src/marketplace/limits.ts. Subscription tiers, hosted services and a future fee are not claims about current shipped paid products.

## 12. Five-year direction (0:35)

**On slide**

- **Year 1:** reliable personal agents, complete execution evidence and independent security review.
- **Year 2:** controlled production pilots after security and setup gates.
- **Year 3:** developer SDK, more specialists and reusable workflows.
- **Year 4:** broader business administration and operating controls.
- **Year 5:** stronger privacy and wider settlement integrations, guided by demand.

Direction, not guaranteed delivery dates.

**Speaker notes**

“The first year focuses on reliability, evidence and closing known gaps. Production pilots follow security review and a suitable trusted setup. Then we can grow developer integrations and the specialist ecosystem, expand team operations and explore stronger privacy and broader settlement support. Each stage depends on demonstrated demand and safe operation.”

This is the final slide. No fundraising ask or additional next-milestone slide.

## Astra review outcome

Conceptually aligned with the exact topic's asset-management, transaction-execution and risk-control requirements. The wallet's actual on-chain execution must stay explicit within the broader workspace and marketplace story. Ambition does not guarantee bonus points. Current evidence is incomplete for the strongest unattended-autonomy and private-marketplace claims. Devnet and reference-reuse eligibility are separate organizer questions.
