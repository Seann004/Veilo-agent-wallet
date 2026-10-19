# Agent workflows

**Verification scope:** see [current status](./status.md). The recorded M2 proof run is **verified on devnet**; integrated flows are **verified on local test validator** with a **fixture / mock provider**. The Shawn/Prince/Mira demo has one recorded pre-merge **verified on devnet** run with live inference. Marketplace code is on `main`; a private-pool-funded hire is **not yet run** on devnet.

## Owner-created agents

Creation/configuration is implemented through owner control routes and the dashboard (`/agents/new`, `/agents/<id>`; role templates are listed in the marketplace under `/marketplace`). Execution uses the credit-manager, research, content and `custom` roles; it is not an arbitrary code runtime. The dashboard no longer offers the credit-manager role for new agents; the seeded Shawn still uses it. New agents need scoped worker credentials in the runner configuration: `demo:seed` provisions the seeded roles, and with `CONTROL_PROVISION_RUNNER_CREDENTIALS=1` control issues one for each activated agent and the runner reloads the file without a restart. The create form can draft limits from a plain-language description with a deterministic rule-based parser (not a model); the result is only a draft until the owner reviews, creates and activates it. Guests (`VEILO_GUEST_PUBKEYS`) can run agents within their policies but cannot create or configure them or attach a reference image.

Owners create and configure agents with their own names, jobs, triggers, budgets and service permissions. The examples below demonstrate three useful workflows; they do not limit the agents an owner can create. Each agent operates within its configured tools and services and the workspace's shared financial limits.

One runner uses different role instructions, tools and independently enforced policies. Names are editable display fields, not authority identities. Owner-created agents cannot autonomously create spending subagents or expand their own permissions.

### The owner's model key

Agent model work runs on the owner's own provider, set once in **Settings** (`/settings`): OpenRouter, Anthropic, OpenAI, Z.ai (GLM) or any OpenAI-compatible URL, a model id and an API key. Control seals the key with AES-256-GCM under `<VEILO_SECRETS_DIR>/control/ai-provider.key` and is its only holder; reads show only the last four characters. Agents get completions through control (`POST /worker/planning`, `POST /worker/ai`), never the key. Each task may make at most four such model calls besides its planning calls, and the calls are audited without their content. Model work costs no USDC; the provider bills the owner directly. When no provider is set, planning falls back to the operator-sponsored trial on the gateway, and Prince and Mira fall back to a paid gateway SKU only if their policy allows one. A model server on loopback is refused unless the operator sets `AI_ALLOW_LOCAL_PROVIDER=1`.

### What a custom agent is told

A custom agent's planner prompt carries the agent's name, the owner's description and only the capabilities its policy enables: attached connector tools, read-only browsing, assigned workflows, marketplace hiring and the devnet swap. A capability that is off is not offered. Text that comes from someone other than the owner (connector tool descriptions and schemas, connector output, web pages, assigned workflow titles, marketplace listings) is fenced as untrusted data; a value carrying the fence marker is discarded rather than passed on.

| Capability | Default | Bound |
|---|---|---|
| Read public web pages | Off (per-agent "Can browse the web") | Control issues a permit per page: active agent, running task, public `http(s)` URL with no credentials or custom port, at most 3 pages per task (the custom planner asks for at most 2). Pages open in a fresh cookie-less installed Chrome context (GET/HEAD only, no downloads, nothing clicked or typed). Every page request uses the shared transport, which validates the address at connection time and stops responses above 5 MB. Redirects are checked at each hop. `RUNNER_BROWSER=off` disables browsing. |
| Read-only connector tools | None attached | At most 2 planner-chosen calls per custom task; control caps calls per task (`CONNECTOR_CALLS_PER_TASK`, default 5) and per agent per day, pins tool digests and refuses changed tools. |
| Devnet USDC to SOL swap | Off | Only after the owner approves a maximum per swap and adds the swap to the agent's allowed purchases (see below). |
| Assigned workflows | None | The owner assigns a workflow with a budget or with approval for each run (`askEachRun`); proposals outside it wait for the owner. |
| Marketplace hiring | Off for new custom agents | Each hire needs local approval or a listing grant. |

Finished results can also be sent to one destination per agent (a Telegram bot chat, or a Slack or Discord incoming webhook) that the owner configures on **Connectors** or the agent's page. Control seals the secrets, accepts webhooks only on those services' fixed hosts, and sends the task's saved outputs once as plain text after the task completes. Agents and the model cannot reach this path.

## Owner how-to: swaps, market data and reference images

### Approve agent swaps (maximum per swap)

1. Open **Wallet** and find **Agent swaps**. Enter a maximum per swap (up to 5 USDC) and choose **Approve swaps**. This approves one fixed swap only: USDC to SOL on the pinned Orca devnet whirlpool `5GPCnpWwoDayCP5FVCJT1cS7dePufC5FrjPTVvPoUYnm`, 1% slippage, with the SOL sent to `OWNER_RECOVERY_ADDRESS`.
2. In the agent's spending limits, add "Swap USDC to SOL" (group Swaps) to its allowed purchases and activate the policy. Swaps and hiring are off by default for new custom agents. The agent is offered the swap only while both the approval and the allowed purchase are in place.
3. Ask the agent, for example, "swap 0.5 USDC to SOL". The agent may request any amount up to the approved maximum; it cannot choose the pool, direction or destination. Control refuses an amount above the maximum, binds the amount into the request digest and prices the purchase at the requested amount, so every per-purchase, task, agent and workspace limit applies to it.
4. The answer reports "Swapped", or "Requested; settling privately" while control finishes the swap after the task ends. The transaction appears under Wallet activity.

Choosing **Update** changes only the maximum. Removing the approval refuses new swaps at authorization and cancels a reserved swap whose proof was not yet released; a swap whose funding was already released keeps settling or becomes recoverable. Devnet pool prices are not market prices. The swap runs only when the wallet has swaps configured and `OWNER_RECOVERY_ADDRESS` is set. The current hardened swap path has **not yet run** end to end on devnet; three earlier swaps finalized on 17–18 October using the older path; see [payments](./payments.md#devnet-swap) for the flow and its known gaps.

### Attach CoinGecko market data

The marketplace connector `coingecko-market` offers three read-only tools that Veilo defines: `coingecko_simple_price` (price and 24-hour change for 1 to 10 coin ids), `coingecko_trending` and `coingecko_search` (find a coin id), plus CoinGecko's docs search. Each tool runs a fixed code template through CoinGecko's `execute` tool; the agent supplies only schema-checked values such as coin ids and currencies, never code. The approval pins the template code digest and the upstream `execute` digest, and calling `execute` directly is refused.

1. Show the existing **CoinGecko docs search only** connector (`coingecko-docs`). To demonstrate adding market data, use **Connectors → Add → Custom MCP server**, enter `https://mcp.api.coingecko.com/mcp`, choose **Load fixed queries**, then **Submit for review**. It stays **In review** until the operator approves it. The targeted command `pnpm marketplace:connector coingecko-market` previews only this connector; after the proposal is shown, the operator may add `--confirm` to approve it. Do not run the full seed for this flow. Catalogue activation and an attached-agent website acceptance run are still outstanding.
2. Open **Connectors** (`/connectors`), attach CoinGecko market data to a custom agent, then ask it a market question.
3. The answer cites "CoinGecko (mcp.api.coingecko.com)" as the source. Connector calls are free, keyless and not private: CoinGecko sees the requested coin ids.

### Attach a reference image

On a custom agent's composer, drag a PNG, JPEG or WebP image (up to 2 MB) onto the **Reference image** zone or browse for one. The dashboard re-encodes it as JPEG at most 1280 px on its longest side; control refuses anything over 1.5 MB or whose bytes do not match its type. Control stores the image apart from the task input, so the runner never receives it. During the task, control asks the owner's model to describe the image's visual style; the agent receives only that short text, treated as untrusted model output. The style fills a workflow's declared `style` input and is included in a specialist hire brief. Only the owner's model provider sees the image. It requires a configured model key.

## Marketplace agents and specialists — in code, devnet acceptance pending

The v3.2 target allows arbitrarily named agents with their own instructions, triggers and tools. Shawn, Prince and Mira are seeded examples of the coded roles. A buyer can manually hire one reviewed specialist, or let an agent search and propose within owner-defined permissions; a new seller needs owner approval. That approval cannot bypass budgets or change an immutable payout recipient.

A `custom` role can search the marketplace and propose hires; owners approve each hire on the Local approval page or install a listing grant. Searchable reviewed listings, managed execution on the seller host, remote sellers and read-only MCP connectors (`/connectors`) are implemented; free (zero-price) specialist jobs are not. A private-pool-funded hire has not yet run on devnet. Read-only connectors are the default; arbitrary uploaded code and paid recursive delegation are excluded. The existing local Prince-to-Mira handoff is not marketplace hiring. See [marketplace](./marketplace.md) and [T17–T23 triage](./marketplace-triage.md).

## Shawn — shared-credit replenishment

The threshold decision is deterministic and requires no paid model call. Default check interval: 60 seconds. Demo policy: threshold 200,000 gateway units, pack 1,000,000 units, at most 1.00 USDC per pack, 3.00 USDC rolling 24-hour cap, 10-minute minimum interval between successful top-ups, one unresolved top-up per shared account.

Read a fresh balance/version. If low and allowed, create one stable purchase operation. Repeated checks reuse it. Wait for settlement and credited-once issuance before evaluating another purchase. Stale balances or unresolved outcomes pause the check. A manual “Check now” must execute the same logic as the scheduler.

## Prince — paid research

The owner supplies the question, optional sources and deadline. Prince proposes a plan, chooses at least one relevant approved fixed-price data service and runs its analysis on the owner's model key; without a configured key it may buy inference through credits or a separate direct payment when its policy allows. Save a brief with evidence links and purchase references. Label licensed fixture data explicitly and mark unsupported claims; do not fabricate citations.

## Mira — content creation

The owner supplies topic, audience, channels, voice and deliverables, or explicitly approves a Prince handoff. Mira writes the content package on the owner's model key; without one she chooses an approved content SKU and, in this example workflow, pays directly through the private devnet x402 path. The local rehearsal uses a **fixture / mock provider** to produce three editable channel-specific posts and a seven-day calendar. Devnet run `2026-10-17-1eba868c` (before PR #3 merged) paid the content package by direct private x402 and used live DeepSeek V4 Flash inference; see the [demo checklist](./demo.md).

Track editable, needs review, approved for export and archived. Editing, approving or changing a planning date does not buy inference. Regeneration is a new budgeted operation. Mira has no social credentials or publishing tool. (TikTok drafting and opt-in public posting exist only as marketplace seller-host tools; see [configuration](../configuration.md#tiktok-carousel-workflow-run-checklist).)

## Bounded execution

Default limits per task: eight tool calls, three paid purchases and ten minutes. Planning permits at most two bounded calls per task, on the owner's model key or, without one, the operator-sponsored trial model; report sponsored cost separately. Execution must remain within the configured owner policy.

A model refusal is not a financial control. Malicious retrieved text remains untrusted, and the independent policy/signing boundary must reject unauthorized requests even if the model follows that text.
