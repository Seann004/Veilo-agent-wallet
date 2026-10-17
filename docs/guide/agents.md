# Agent workflows

**Verification scope:** see [current status](./status.md). The recorded M2 proof run is **verified on devnet**; integrated flows are **verified on local test validator** with a **fixture / mock provider**. Full devnet agent acceptance lacks complete evidence here. Marketplace acceptance is **not yet run** in this checkout.

## Owner-created agents

Creation/configuration is implemented through owner control routes. Execution uses the credit-manager, research and content role templates; it is not an arbitrary agent runtime. New research/content agents also need scoped worker credentials in the runner configuration; `demo:seed` initially provisions the seeded Prince/Mira roles. Natural-language policy drafting is not implemented.

Owners create and configure agents with their own names, jobs, triggers, budgets and service permissions. The examples below demonstrate three useful workflows; they do not limit the agents an owner can create. Each agent operates within its configured tools and services and the workspace's shared financial limits.

One runner uses different role instructions, tools and independently enforced policies. Names are editable display fields, not authority identities. Owner-created agents cannot autonomously create spending subagents or expand their own permissions.

## Marketplace agents and specialists — pending T19–T22

The v3.2 target allows arbitrarily named agents with their own instructions, triggers and tools. Shawn, Prince and Mira become managed templates. A buyer can manually hire one reviewed specialist, or let an agent search and propose within owner-defined permissions; a new seller needs owner approval. That approval cannot bypass budgets or change an immutable payout recipient.

The current runner and database still restrict execution to three coded roles; free specialist jobs, searchable seller listings, reviewed managed/remote execution and connector grants are not implemented here. Read-only connectors are the default; arbitrary uploaded code and paid recursive delegation are excluded. The existing local Prince-to-Mira handoff is not marketplace hiring. See [marketplace](./marketplace.md) and [T17–T23 triage](./marketplace-triage.md).

## Shawn — shared-credit replenishment

The threshold decision is deterministic and requires no paid model call. Default check interval: 60 seconds. Demo policy: threshold 200,000 gateway units, pack 1,000,000 units, at most 1.00 test-USDC per pack, 3.00 test-USDC rolling 24-hour cap, 10-minute minimum interval between successful top-ups, one unresolved top-up per shared account.

Read a fresh balance/version. If low and allowed, create one stable purchase operation. Repeated checks reuse it. Wait for settlement and credited-once issuance before evaluating another purchase. Stale balances or unresolved outcomes pause the check. A manual “Check now” must execute the same logic as the scheduler.

## Prince — paid research

The owner supplies the question, optional sources and deadline. Prince proposes a plan, chooses at least one relevant approved fixed-price data service and purchases permitted inference through credits or a separate direct payment. Save a brief with evidence links and purchase references. Label licensed fixture data explicitly and mark unsupported claims; do not fabricate citations.

## Mira — content creation

The owner supplies topic, audience, channels, voice and deliverables, or explicitly approves a Prince handoff. Mira chooses an approved content SKU and, in this example workflow, pays directly through the private devnet x402 path. The local rehearsal uses a **fixture / mock provider** to produce three editable channel-specific posts and a seven-day calendar. Operator-funded live inference with the direct devnet content payment is **not yet run**.

Track editable, needs review, approved for export and archived. Editing, approving or changing a planning date does not buy inference. Regeneration is a new budgeted operation. The current scope has no social credentials or publishing tool.

## Bounded execution

Default limits per task: eight tool calls, three paid purchases and ten minutes. Sponsored planning permits at most two bounded calls with a fixed allowlisted model; report this cost separately. Execution must remain within the configured owner policy.

A model refusal is not a financial control. Malicious retrieved text remains untrusted, and the independent policy/signing boundary must reject unauthorized requests even if the model follows that text.
