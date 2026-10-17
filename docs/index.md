# Veilo documentation

An owner-controlled workspace for AI agents that buy approved resources within delegated budgets, using a shared private funding pool on Solana devnet. PRD v3.2 extends it with a marketplace of reviewed, paid specialist agents.

## Current verification status

The recorded M2 pool/Echo smoke is **verified on devnet**. Integrated payments/recovery are **verified on local test validator**; Shawn, Prince and Mira use a **fixture / mock provider** in local rehearsal. A parallel branch reports a later devnet gateway execution, but complete task/live-inference acceptance evidence is missing here. Marketplace acceptance is **not yet run** in this checkout. See [current status](./guide/status.md), [running Veilo](./guide/running.md), the [demo checklist](./guide/demo.md) and [handoff gaps](./handoff.md). The setup is deterministic and for development test funds only; this is not an audited or mainnet-ready system.

## Marketplace scope in v3.2

Buyers will discover reviewed specialist agents, hire one at a fixed price and receive deliverables through a private job board. Sellers will complete operator-reviewed setup and receive payment directly through x402, with an explicit zero platform fee and earnings shown as finalized receipt history. Supabase holds marketplace identity and product data; local control and wallet services retain spending authority. These marketplace features are accepted requirements, not implemented capabilities in this checkout.

See [Marketplace](./guide/marketplace.md) for buyer/seller flows, two sign-ins, direct settlement and limits, and [implementation triage](./guide/marketplace-triage.md) for every T17–T23 gate and §26.6 acceptance check. The existing local workspace continues to run without Supabase.

## Existing local workspace

Create agents that can buy approved digital resources and complete jobs within your rules. Give each agent a name, objective, trigger, budget and service permissions. The workspace combines useful agent work, independent spending controls and a private funding path.

### User flow

1. Connect your owner wallet and deposit test funds into the shared pool.
2. Create an agent and configure its job, allowed services, budget and approval mode.
3. Start a task or enable its trigger. The agent proposes the resources it needs.
4. The control and wallet services check policy, reserve funds and authorize a permitted purchase.
5. A proof-authorized pool withdrawal funds a fresh payment wallet, which pays the service through x402.
6. Receive the result and inspect spending, outputs and pending operations. Pause or revoke an agent when needed.

### Why combine these pieces?

- **Delegation:** agents can purchase the resources their jobs need without repeated manual payments when policy permits.
- **Control:** separate agent limits and shared workspace caps constrain financial exposure.
- **Funding privacy:** the payment path aims to remove the explicit link from a particular deposited note to its payout.
- **Owner visibility:** keep local attribution of which agent requested a purchase and what it produced.
- **Recovery:** track uncertain payments and delivery separately so retries do not blindly create another charge.

Veilo's contribution is the integration of owner-created agents, delegated policy, private funding and useful paid workflows. Privacy pools and x402 are existing foundations; the design does not claim to invent them.

### Does a private payment hide which agent or wallet paid?

The merchant payment wallet and transfer are public. The intended privacy property is hiding the explicit link back to the original deposited note and its funding wallet. Public transactions do not carry a stable agent name or workspace ID, but this does not make the agent unidentifiable to everyone: the owner retains local attribution, the gateway can link authenticated usage, and timing or amounts can support correlation. See [privacy and trust](./guide/privacy.md).

## Follow the system

1. [Architecture](./guide/architecture.md): components, trust boundaries and enforcement ownership.
2. [Payment lifecycle](./guide/payments.md): private funding, ordinary x402 and durable recovery.
3. [Privacy and trust](./guide/privacy.md): intended protection, public metadata and operator visibility.
4. [Security model](./security/assessment.md): permission tiers, authentication and enforcement boundaries.
5. [Verification requirements](./security/evidence.md): acceptance cases the implementation must demonstrate.

## Create your own agents

The existing workspace lets owners create and configure named agents using credit-manager, research and content role templates. Shawn, Prince and Mira are seeded examples. PRD v3.2 requires generic agents and specialists with owner-defined instructions/tools; that execution model is pending T19. All agents remain subject to workspace-wide limits.

### Demo examples

| Agent | Job | Intended purchased outcome |
|---|---|---|
| Shawn | Monitor the shared gateway credit balance | Buy one bounded inference-credit pack when the threshold is crossed |
| Prince | Research an owner-supplied question | Buy approved data/inference and save an attributable research brief |
| Mira | Create content from a brief or approved research handoff | Directly buy a content package and save three editable posts plus a seven-day calendar |

The model proposes work. An independent wallet/control service authorizes money. Agents share the workspace treasury and gateway credit account, with separate agent limits.

## Network and service boundaries

- Settlement uses test assets on Solana devnet. SOL pays chain costs separately.
- Real inference is paid for by the gateway operator's OpenRouter account. Test USDC does not replenish commercial provider funds.
- Gateway credits are application service entitlements, not OpenRouter account credits or redeemable money.
- Research fixtures must be labeled demo data; fixture output does not prove live search.
- Content scheduling means planning dates and local editable posts. External social publishing is outside the current scope.
