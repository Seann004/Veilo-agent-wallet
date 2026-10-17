# Agent workflows

**Verification scope:** see [current status](./status.md). The recorded M2 proof run is **verified on devnet**; integrated flows are **verified on local test validator** with a **fixture / mock provider**. The Shawn/Prince/Mira demo has one recorded pre-merge **verified on devnet** run with live inference. Marketplace code is on `main`; a private-pool-funded hire is **not yet run** on devnet.

## Owner-created agents

Creation/configuration is implemented through owner control routes and the dashboard (`/agents/new`, `/agents/<id>`; role templates are browsable at `/market`). Execution uses the credit-manager, research, content and `custom` roles; it is not an arbitrary code runtime. New agents also need scoped worker credentials in the runner configuration; `demo:seed` initially provisions the seeded Prince/Mira roles. The create form can draft limits from a plain-language description with a deterministic rule-based parser (not a model); the result is only a draft until the owner reviews, creates and activates it. Guests (`VEILO_GUEST_PUBKEYS`) can run agents within their policies but cannot create or configure them.

Owners create and configure agents with their own names, jobs, triggers, budgets and service permissions. The examples below demonstrate three useful workflows; they do not limit the agents an owner can create. Each agent operates within its configured tools and services and the workspace's shared financial limits.

One runner uses different role instructions, tools and independently enforced policies. Names are editable display fields, not authority identities. Owner-created agents cannot autonomously create spending subagents or expand their own permissions.

## Marketplace agents and specialists — in code, devnet acceptance pending

The v3.2 target allows arbitrarily named agents with their own instructions, triggers and tools. Shawn, Prince and Mira are seeded examples of the coded roles. A buyer can manually hire one reviewed specialist, or let an agent search and propose within owner-defined permissions; a new seller needs owner approval. That approval cannot bypass budgets or change an immutable payout recipient.

A `custom` role can search the marketplace and propose hires; owners approve each hire on the Local approval page or install a listing grant. Searchable reviewed listings, managed execution on the seller host, remote sellers and read-only MCP connectors (`/connectors`) are implemented; free (zero-price) specialist jobs are not. A private-pool-funded hire has not yet run on devnet. Read-only connectors are the default; arbitrary uploaded code and paid recursive delegation are excluded. The existing local Prince-to-Mira handoff is not marketplace hiring. See [marketplace](./marketplace.md) and [T17–T23 triage](./marketplace-triage.md).

## Shawn — shared-credit replenishment

The threshold decision is deterministic and requires no paid model call. Default check interval: 60 seconds. Demo policy: threshold 200,000 gateway units, pack 1,000,000 units, at most 1.00 USDC per pack, 3.00 USDC rolling 24-hour cap, 10-minute minimum interval between successful top-ups, one unresolved top-up per shared account.

Read a fresh balance/version. If low and allowed, create one stable purchase operation. Repeated checks reuse it. Wait for settlement and credited-once issuance before evaluating another purchase. Stale balances or unresolved outcomes pause the check. A manual “Check now” must execute the same logic as the scheduler.

## Prince — paid research

The owner supplies the question, optional sources and deadline. Prince proposes a plan, chooses at least one relevant approved fixed-price data service and purchases permitted inference through credits or a separate direct payment. Save a brief with evidence links and purchase references. Label licensed fixture data explicitly and mark unsupported claims; do not fabricate citations.

## Mira — content creation

The owner supplies topic, audience, channels, voice and deliverables, or explicitly approves a Prince handoff. Mira chooses an approved content SKU and, in this example workflow, pays directly through the private devnet x402 path. The local rehearsal uses a **fixture / mock provider** to produce three editable channel-specific posts and a seven-day calendar. Devnet run `2026-10-17-1eba868c` (before PR #3 merged) paid the content package by direct private x402 and used live DeepSeek V4 Flash inference; see the [demo checklist](./demo.md).

Track editable, needs review, approved for export and archived. Editing, approving or changing a planning date does not buy inference. Regeneration is a new budgeted operation. The current scope has no social credentials or publishing tool.

## Bounded execution

Default limits per task: eight tool calls, three paid purchases and ten minutes. Sponsored planning permits at most two bounded calls with a fixed allowlisted model; report this cost separately. Execution must remain within the configured owner policy.

A model refusal is not a financial control. Malicious retrieved text remains untrusted, and the independent policy/signing boundary must reject unauthorized requests even if the model follows that text.
