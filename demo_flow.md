# Veilo demo flow and scripts

## Current recording: wallet, custom MCP and public carousel

Use the existing **Swap Bot** and **Content Writer**. Creating another agent repeats setup without helping this short recording; keep creation as an optional extra. Target an edited **4:45** and cut typing, signing and generation waits.

| Time | Click / action | What to say |
|---|---|---|
| 0:00–0:15 | Landing page → Open workspace | “Veilo combines a personal agent workspace, private on-chain payments and an agent marketplace.” |
| 0:15–0:40 | Wallet → Add funds → deposit devnet USDC → confirm Ready to spend | “I fund the private pool once, then my agents can pay within the permissions and spending limits I set.” |
| 0:40–1:25 | Connectors → Add → Custom MCP server → paste CoinGecko URL → Add connector → Add to agent → Swap Bot; ask the SOL question below | “I can connect an external MCP server by adding its URL. Here, Swap Bot uses CoinGecko for current market data.” |
| 1:25–2:05 | Swap Bot → send swap prompt → open its completed receipt → swap transaction in Solana Explorer | “The agent swapped 0.01 USDC through Orca. This receipt shows the actual SOL output and my receiving wallet. The transaction hash lets me verify it on-chain.” |
| 2:05–2:40 | Marketplace → TikTok carousel (designed, posts publicly) → Add to an agent → Content Writer → Ask me before each run | “This marketplace workflow researches and plans a carousel, renders its slides and publishes to the connected TikTok account. I give my agent access, with approval required for each run.” |
| 2:40–3:05 | Content Writer → More options → attach reference image → send carousel prompt below | “I describe the result I want and attach a visual reference. The agent prepares the workflow inputs for me.” |
| 3:05–3:40 | Review and approve → inspect slide count, style, topic, steps, total and destination → Approve and run → Confirm approval | “Before anything runs, I review what will be created, what it costs and where it will be published. Then I approve this run.” |
| 3:40–4:30 | Open run → Show output → Load images → inspect step receipts → open confirmed public post | “Here are the five slides, the workflow steps and their payment receipts. This is the finished post.” |
| 4:30–4:45 | Completed run / workspace | “From a simple request to a finished result: agents use tools, pay for services and hire workflows, while I control their permissions.” |

### Copyable prompts

CoinGecko endpoint: `https://mcp.api.coingecko.com/mcp`

SOL market data:

> What is SOL's current price in USD and its 24-hour change? Use CoinGecko and include the source.

Swap:

> Swap exactly 0.01 USDC to SOL.

Carousel, with the reference image attached:

> Create a 5-slide TikTok carousel about the top 3 repositories on GitHub Trending this week: https://github.com/trending?since=weekly. Include a cover, one slide per repository, and a final call to action. Match the visual style of my attached image and include the repository links in the caption.

### Check before recording

- Attach the newly added CoinGecko market-data connection to Swap Bot, rather than the docs-search-only connector. The custom connection adds immediately without operator approval or marketplace sign-in. It was already added during QA: show the existing connection honestly, or reuse Add to show the actual update; do not claim a first-time registration.
- Swap Bot must have the USDC-to-SOL purchase enabled and sufficient agent/workspace limits. CoinGecko's market price is separate from the devnet pool's swap rate.
- On the completed swap receipt, distinguish actual SOL output from returned token-account rent. If the wallet's total SOL increase is larger, say: “The additional SOL is returned account rent, shown separately.” Use the swap signature to demonstrate the trade; the private-pool funding signature is a separate transaction.
- Assign the current reference-style public workflow to Content Writer with **Ask me before each run**. Confirm its model can read the attachment and that the actual review screen contains a usable reference-style description. The renderer follows bounded colors, font category, alignment and shapes; it does not reproduce every image detail.
- Review the actual publishing account and public effect before approval. This workflow proceeds through publication after approval; adjust the request before approving. It has no intermediate image-editing stop.
- Use the run's displayed quote, not a memorized price. Owner model and seller-provider credits may cost real money separately from devnet settlement.
- Rehearse one complete run before filming. Only call it published after opening the confirmed public post. If still pending, say “The run is processing” and show a clearly identified completed rehearsal; do not create a duplicate run or post to fill the wait.

The image-only **TikTok carousel (reference-style preview)** is available for rehearsal without posting. The last automated attempt did not upload the reference image because Chrome file access was disabled, so it did not generate images or publish. See [reference publishing](docs/guide/reference-publishing.md) for version setup.

---

## Earlier draft-only rehearsal reference

The sections below describe the separate draft-only workflow. Do not use their draft narration for the public workflow above.

Solana devnet only. Every on-chain step uses devnet USDC and devnet SOL. Real model and Higgsfield usage is billed separately; devnet tokens have no cash value.

## Recording readiness

Check the [current status](docs/guide/status.md) and [recorded evidence](docs/evidence.md) before filming. Automated tests and historical receipts do not establish that today's browser flow has completed.

**Recording gates:** rehearse the current USDC-to-SOL swap, one paid carousel with its actual destination, and an eligible-note owner withdrawal. Save each run ID, UTC time, source commit, finalized transaction links and output before marking that segment ready. If any gate fails, omit that segment or clearly identify an earlier recording and its scope. Never present a historical backend run as a current browser rehearsal.

The carousel quote is expected to contain three paid steps totalling 0.23 devnet USDC before any additional permitted fees. The displayed approved quote is authoritative. Model and image generation use real provider credits. A configured key does not establish sufficient credits or successful delivery.

The social workflow requests an inbox draft, not a guaranteed private-audience post. Verify the destination account and draft-only effect in the actual review screen. Do not publish during the demonstration.

CoinGecko docs search and market data are separate connectors. Check Discover before recording: if market data is already approved, demonstrate attaching and using it, rather than pretending to register it for the first time.

This file covers:
1. Pre-demo checklist
2. Live demo flow, with what to say at each step (about 8 to 10 minutes)
3. A 3 to 5 minute demo video, with a shot list and voiceover

---

## 1. Pre-demo checklist (do this the day before, then again 30 minutes before)

**Environment**
- [ ] Record the current source commit; install its dependencies and restart the local stack. Confirm dashboard http://localhost:3000 and service health on the intended devnet deployment. Recheck after any code or configuration change.
- [ ] Phantom is on **devnet** and holds at least 5 USDC plus 0.1 SOL. Sign in to the dashboard with it.
- [ ] Close other heavy apps. The machine slows down under load.

**Money and limits**
- [ ] Wallet → Add funds: deposit **5 USDC**, and wait until it shows as "Ready to spend".
- [ ] Pause unrelated scheduled agents during QA. Check the workspace's **total remaining**, **rolling 24-hour remaining**, sponsor allowance and ready pool funds. All must cover the rehearsal. Do not raise limits to 50/20 merely for the script; no workspace-limit editor is currently exposed in the website. Any necessary increase is a separate owner policy action.
- [ ] Treat **Pool total (all depositors)** as the public whole-pool figure, not your spendable balance. Use **Ready to spend** for your own funds.
- [ ] Wallet → Agent swaps: set the **maximum per swap to 1.50 USDC** (supported server ceiling: 5 USDC). This does not override the agent's smaller limits; rehearse with only 0.01 USDC.

**Agents (create them in advance so the demo doesn't wait on setup)**
- [ ] **Swap Bot** (Custom): limits 0.50 per purchase / 1.00 per task / 2.00 total; set an explicit rolling 24-hour limit within the total. Enable the approved USDC → SOL swap. Use an automatic tier for this small swap.
- [ ] **Creator Bot** (Custom): limits 0.50 per purchase / 1.00 per task / 3.00 total, plus an explicit rolling 24-hour limit. Hiring and Browsing on. Its marketplace hiring caps and workflow allowance must also cover the displayed 0.23 USDC run.
  - Assign the workflow **"TikTok carousel from a topic"** (DeepSeek → Higgsfield → Zernio draft) with **"Ask me before each run"**.
  - Attach **Solana Developer MCP** for a separate free connector check. It is a documentation source, not the source for GitHub trends.
- [ ] Settings → AI model: verify the configured key/model answers a plain prompt. Check image support separately: a text-only model may continue without a usable style description.
- [ ] Sign into the marketplace with the same intended owner wallet and confirm its local controller is linked. Local owner sign-in and marketplace sign-in are separate.
- [ ] A reference image is ready on your desktop (PNG/JPG/WebP, 2 MB or less), with a clear visual style.

**Rehearse once, end to end**
- [ ] Run "Swap 0.01 USDC to SOL" once. Use the current code and verify its own receipts before recording.
- [ ] After reviewing the three-step quote, approve exactly one carousel rehearsal and check that the draft lands in the TikTok Creator Inbox ("shawndevtesting"). Higgsfield bills real credits.
- [ ] Keep these tabs open:
  - Solana Explorer (devnet);
  - one finished run page;
  - one finished swap, as a fallback if the live run is slow.

**Backup plan**
- [ ] If a live step is still waiting after 30 seconds, switch to the pre-run tab and say: "The live run is still waiting. Here is a completed rehearsal of the same flow, with its own transaction."

---

## 1a. Website QA order (complete before rehearsing)

1. **Workspace and Wallet, no spending:** verify devnet, owner sign-in, theme/mobile layout, your ready/held/pending figures, the separately labelled public pool total and weak-pool warning. Refresh once and confirm agent names/statuses, archived disclosure and recent-payment links.
2. **Model, connector and browser, no on-chain purchase:** create a fresh custom agent; ask “Who are you?”; ask the attached Solana MCP for a documentation answer with a real source; ask it to read `https://github.com/trending?since=weekly` and list the first three repos shown with links. Do not say “top three this week” unless that page was actually retrieved. Owner-model calls can still incur provider charges.
3. **Guardrails before the first swap:** confirm the approved maximum and fixed USDC → SOL direction. Ask “Swap SOL to USDC” and check for no swap. With a 0.50 per-purchase agent limit, request exactly 0.60 USDC and confirm refusal without a new on-chain payment. Then ask “Swap exactly 0.01 USDC to SOL.” Check the recorded amount, finalized funding and swap signatures, pinned pool, destination and SOL arrival. Do not repeat an uncertain swap; inspect its existing payment first.
4. **CoinGecko personal connector:** Connectors → Add → Custom MCP server → paste `https://mcp.api.coingecko.com/mcp` → Add connector. Attach the discovered market-data tools to a custom agent, then ask for Bitcoin's USD price and 24-hour change with sources. No operator approval is required; this personal connection is local to the workspace. Tools are pinned and rechecked on calls. The existing CoinGecko docs-search connector cannot fetch prices.

5. **Carousel review before paying:** assign the styled `tiktok-carousel-from-topic` workflow with “Ask me before each run.” Attach an image, request five slides, and verify the actual style description, slide count, three quoted steps, total, **draft-only** effect, owner wallet/controller and `@shawndevtesting` destination. Stop if any term is wrong.
6. **One paid carousel rehearsal:** approve one run. Expected devnet tool prices: planner 0.02 + images 0.20 + draft 0.01 = 0.23 USDC, subject to the displayed approved terms. Higgsfield/model usage also spends real credits. Check each step's payment and output, five loadable images, final caption and an inbox draft in TikTok. Refresh the existing run; do not start a second paid run merely because the first is slow. Confirm nothing was published automatically.
7. **Pause, revoke and exit last:** first pause/resume a disposable QA agent, then revoke it and confirm new work is blocked. Keep stage agents usable. Wait for live payments to resolve, then test the public owner exit on an eligible note with Phantom; the UI shows the actual amount and signing requirement. Verify the finalized signature and receipt. Do not promise immediate withdrawal of pending, reserved or uncertain funds.

For every payment, record the task/run ID, requested amount, finalized funding signature, finalized settlement or swap signature, and output/destination. A successful screen message alone is insufficient evidence.

## 1b. Optional four-minute website demonstration

The canonical presentation proposal in `slide_deck.md` has 12 slides, a 5:40 speaking target and no demo slide or embedded demonstration. This optional website demonstration is separate. If both use the same ten-minute presentation slot, rehearse the complete session, including transitions, below that limit. The full walkthrough below is an 8–10 minute standalone demo. For the shorter website demonstration:
- 0:00–0:20: Wallet, your balance versus the public pool total, weak-pool disclosure.
- 0:20–0:40: workspace and agent caps.
- 0:40–1:50: reverse-swap refusal, then the rehearsed 0.01 USDC swap and its two main transaction legs. If still pending after 30 seconds, disclose and show the completed rehearsal.
- 1:50–3:05: show the image/style and draft-only review terms, then the completed rehearsal's three payments, five images and TikTok inbox draft. Explicitly say it was prepared earlier; do not imply it completed live.
- 3:05–3:40: a small-limit refusal or a disposable agent's pause/revoke, explaining that already released payments may still settle.
- 3:40–4:00: the rehearsed public exit receipt and the close. A new exit is optional only if there is time and an eligible note.

## 2. Live demo flow and script

### Step 0: Hook (30 s) [Landing page]
"Agents are starting to spend money. Two common starting points are an unrestricted wallet or approval for every payment. Veilo combines delegation with independent spending controls. Each agent gets a budget, pays through a private pool, and you can stop it any time. Everything you'll see runs on Solana devnet."

### Step 1: The treasury (60 s) [Wallet] **[F: asset management]**
- [Show Ready to spend, Held for purchases and On the way.]
  "This is my private pool balance. I deposited USDC from Phantom. The on-chain proof enforces ownership, approved membership and conservation. A separate control service enforces the spending limits."
- [Open the deposit confirmation link while it is visible, or the saved deposit receipt in Explorer. The deposits table itself does not currently open a transaction drawer.]
  "Here's the deposit on chain. When an agent pays, the pool withdraws to a fresh, single-use wallet, and that wallet pays the merchant."
- [Settings → Privacy, briefly.]
  "To be honest about privacy: the pool hides *which deposit* paid. Amounts, merchant and timing are public, and with a small pool the privacy is weak. We show that warning in the product."

### Step 2: Limits that hold (45 s) [Workspace] **[F: risk control]**
- [Show the Workspace cards: Left today, Spent and its cap-used detail.]
  "There are two layers of limits. The workspace has a total and a rolling 24-hour limit. Each agent has its own per-purchase, per-task and total limits. A purchase must fit all of them at once, and it's reserved atomically before anything is signed."

### Step 3: An agent that swaps (90 s) [Swap Bot chat] **[F: transaction execution, autonomous]**
- Type "Who are you?"
  "It knows its job: it's Swap Bot, and it can swap USDC to SOL up to my maximum."
- Type "Swap SOL to USDC"
  "It refuses. The only swap I approved is USDC to SOL on one pinned Orca pool. The model can't change the pool, the direction or where the SOL goes."
- Type "Swap 0.01 USDC to SOL"
  "Now it acts on its own, inside my limits. No pop-up and no extra approval: the amount is under its limits and under the maximum I set."
- [Open the payment card, or Activity if chat says “Requested; settling privately.” Inspect the existing payment and its finalized receipts → open Explorer → show SOL arriving in Phantom. Never issue another swap to resolve a pending display.]
  "Two main transaction legs here. First, the pool withdraws the USDC to a fresh wallet; that withdrawal is authorized by a Groth16 proof verified on chain. Then that wallet does one Orca swap, and the SOL lands in my wallet. Before co-signing, the relayer checks that this is exactly the approved swap and nothing else."

### Step 4: An agent that hires and pays a creative pipeline (2.5 min) [Creator Bot chat] **[F: autonomous ops, transaction execution]**
- [More options → drag in the reference image → a thumbnail appears.]
- Type "Read https://github.com/trending?since=weekly. Use the first three repos shown, cite the source links, and propose a five-slide TikTok carousel in my attached image's style. Use only my assigned draft workflow and wait for approval."
- [Live steps appear: reading GitHub trending → choosing a workflow. Confirm a real proposal with the intended inputs; if the model only answers in chat or produces an invalid proposal, stop and use the disclosed rehearsal rather than resubmitting.]
  "It does the research itself with read-only browsing, then picks the workflow I assigned to it."
- [Open "How I did it".]
  "It read the style from my reference image. The source image stays in the local workspace and is sent to my configured model provider. The workflow receives only a text description of the style. If the model cannot read the image, I disclose that rather than claim a match."
- [Review and approve → inspect the draft-only effect and terms → Approve and run → Confirm approval.]
  "This workflow buys three tools from the configured seller: DeepSeek plans the slides, Higgsfield makes the images, and Zernio drops an inbox draft into TikTok. I asked to approve each run, so I approve this one."
- [The run page updates by itself: Planner → Higgsfield → Zernio. No need to start a second run. Load images.]
- [Open the payment cards → one Explorer link.]
  "Each step is a separate private payment over x402: a proof-authorized pool withdrawal, then a standard x402 settlement to the seller. Three steps, three devnet tool payments, all within this agent's spending limits. The AI and image providers also charge real credits separately."
- [Phone or TikTok app: the draft is in the Creator Inbox.]
  "And here's the carousel as a draft. Nothing was published."

### Step 5: Guardrails (60 s) [Creator Bot settings] **[F: risk control]**
- [Use a disposable QA swap agent with a 0.50 USDC per-purchase limit. Request exactly 0.60 USDC, within the workspace-approved swap maximum.]
  "This request exceeds the agent’s per-purchase limit. Veilo refuses the on-chain purchase before signing. Model calls can still use provider credits."
- [Revoke a disposable QA agent → new tasks are blocked. Keep Creator Bot usable for the rest of the demo.]
  "Revoking an agent removes its authority to start new work. Payments it had already authorized still settle, or become recoverable by me. The dashboard preserves unresolved states; I inspect and reconcile them rather than blindly retry."

### Step 6: Exit (30 s) [Wallet → Withdraw to my wallet → Phantom]
"Finally, I can exit an eligible pool note using its original refund authority. I wait for live payments to resolve first. This exit is public by design, and the product says so."

### Step 7: Close (20 s)
"Veilo brings your personal agent workspace, private on-chain payments and an agent marketplace together. Agents act within the permissions you set. This is our Solana devnet prototype. Thank you."

**Topic F coverage:** autonomous operations (steps 3 and 4: the swap runs within prior owner approval; the carousel requires one explicit run approval, then each step is paid within the approved terms), asset management (steps 1 and 2), transaction execution (steps 3 and 4: proof-authorized withdrawals, an Orca swap, x402 settlement), risk control (steps 2 and 5), and an ambitious implementation (private funding inside a working multi-agent workspace).

---

## 3. Demo video (3 to 5 min): shot list and voiceover

Record at 1440p or higher with the browser at 90% zoom. The carousel section shows an explicitly labelled completed rehearsal; its timing is an edited recording target, not a live completion promise. Cut waiting time. Show Explorer for at least 2 seconds on each transaction. Add lower-third captions with the transaction signatures.

| # | Time | Shot | Voiceover |
|---|---|---|---|
| 1 | 0:00–0:15 | Landing page and workspace | "Agents are starting to spend money. Veilo gives each one a budget, pays privately, and lets you stop it any time. All on Solana devnet." |
| 2 | 0:15–0:40 | Wallet: balances, then the deposit in Explorer | "I deposit USDC into a private pool. Payments come out through a zero-knowledge proof to a fresh wallet. The pool hides which deposit paid; amounts and merchants stay public." |
| 3 | 0:40–1:00 | Workspace cards and limits; agent limit fields | "The workspace has daily and total limits, and each agent has its own. Every purchase must fit them all before anything is signed." |
| 4 | 1:00–1:45 | Swap Bot: "Who are you?" → "Swap SOL to USDC" (refused) → "Swap 0.01 USDC to SOL" → payment card → Explorer → Phantom SOL | "Swap Bot can only do the swap I approved: USDC to SOL on one Orca pool, up to my maximum. It refuses the reverse. When I ask for 0.01, it acts on its own: a proof-authorized withdrawal, then one Orca swap, and the SOL is in my wallet." |
| 5 | 1:45–3:00 | Creator Bot: drop the reference image → the prompt → live steps → How I did it → approve → run page progressing → images → payment cards → Explorer → TikTok inbox draft | "Creator Bot researches GitHub's trending repos, reads the style of my reference image, and picks a three-step workflow: DeepSeek plans, Higgsfield renders, Zernio sends a draft to TikTok. Real provider credits are separate from devnet settlement. Each step is its own private x402 payment, all within budget. The carousel lands as a draft and is never auto-published." |
| 6 | 3:00–3:30 | Disposable QA swap agent: request 0.60 against a 0.50 per-purchase cap → refused; Revoke → new work refused | "Lower the limit and the on-chain purchase is refused. Revoke the agent and new authority stops; already released payments may still settle or need recovery." |
| 7 | 3:30–3:50 | Eligible note → Withdraw to my wallet → privacy acknowledgement → Confirm withdrawal in Phantom → Explorer | "I can exit an eligible note with my refund authority after live payments resolve. The exit is public, and Veilo tells me so." |
| 8 | 3:50–4:10 | Logo plus three bullet captions | "Private pool payments. Standard x402. Limits that hold. Veilo: your personal agent workspace, private payments and agent marketplace." |

**Captions to show on screen (accuracy):** "Solana devnet · USDC"; "ZK proof verified on chain (Groth16)"; "Pool hides which deposit paid; amounts, merchant and timing are public"; "Not audited".


## Final recording gate

Target **4:10**, leaving 50 seconds under the submission limit for transitions. Cut or disclose waiting time, keep transaction links readable, and show a completed rehearsal only with an explicit “Recorded rehearsal” label. Do not squeeze the optional CoinGecko registration into this cut.

Before recording: pause unrelated agents, leave only intended tabs visible, hide API keys, terminal configuration, wallet recovery phrases and personal notifications. Never open note secrets or proof witnesses on camera. Capture the source commit and run IDs privately with the evidence.

Use a disposable QA agent for limit changes and revocation. Restore any modified limits before filming the main agents. Show a denied request without approving or retrying a paid workflow. For a withdrawal, show the actual eligible note amount and privacy acknowledgement before Phantom signing. Never describe it as withdrawing every remaining fund.

**Ready only when:** the intended model and connector answer, the swap has finalized receipts and the correct owner destination, the workflow has all payment legs and usable outputs plus an inbox draft, and the exit receipt is finalized. A missing gate stays pending. Keep the presentation separate from the video; the deck has 12 slides and the submission video must remain under five minutes.
