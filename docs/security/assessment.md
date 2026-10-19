# Security model

**Verification scope:** see [current status](../guide/status.md). The recorded M2 proof run is **verified on devnet**; integrated flows are **verified on local test validator** with a **fixture / mock provider**. The Shawn/Prince/Mira demo has one recorded pre-merge **verified on devnet** run with live inference. Marketplace code is on `main`; a private-pool-funded hire is **not yet run** on devnet.

Veilo separates agent planning, owner authority, wallet signing, on-chain verification and paid-service delivery. An agent request alone is never sufficient authority to release funds.

## Assessment scope and conclusion

Team self-assessment first written for source snapshot `fe13778` (17 October 2026); the agent-tool section below was added for `59eb491` (19 October 2026) from the source, not from a new review. M2 demonstrates the proof-based devnet funding rail; local integration reports 30/30 cases with mock inference. Neither establishes live agent inference, a completed submission gate, an independent audit or production safety. Permission tiers below are implemented controls with local test coverage; fresh post-merge devnet agent acceptance is **not yet run**. The pre-merge agent run remains historical evidence.

Assets include devnet USDC principal, note/signing/encryption secrets, owner authority, provider quota, ledger integrity and private prompts. Threat actors include malicious services/prompts, impersonating workers, replaying/concurrent callers, compromised gateway/relayer/indexer, hostile host access and faulty circuits/setup/program administrators.

## Marketplace threat and authority extension — in code, devnet acceptance incomplete

The accepted v3.2 design adds independent buyers/sellers and Supabase identity/product records while keeping one owner per workspace. Cloud sign-in is separate from the existing local challenge and never releases spending authority. RLS, explicit grants, sanitized public catalogue projections and private participant Storage are required; direct client writes to quote/job/payment/earnings state are prohibited. Service keys stay server-side. These cloud controls are implemented and pass the live RLS end-to-end script (84/84, with fixture chain reads); a private-pool-funded hire and the offline-controller drill are not yet run.

New threats include cross-tenant reads, forged seller callbacks, payout/version substitution, duplicate receipt attribution, stale workers, malicious result files and compromised hosted execution. The local runner’s restricted tools do not establish a hosted sandbox. The operator/seller/provider can see job content and relationships. The [14 marketplace acceptance checks](../guide/marketplace-triage.md) are mapped to their recorded coverage there; none is closed with devnet settlement evidence for a private-pool-funded hire.

## Agent tools added after the merge

| Path | Control in code | Limit |
|---|---|---|
| Owner's model key | Sealed by control (AES-256-GCM, key file under the secrets directory); agents get completions only; per-task call cap; audit without content | A model reply is untrusted text; control still authorizes every purchase |
| Read-only browsing | Off by default; a control permit per page (public host, no credentials or custom port, page cap); cookie-less Chrome context, GET/HEAD only | Shared transport checks DNS at connection time and aborts responses over 5 MB. This is restricted browsing, not a general hosted sandbox |
| Connector tools | Operator-approved, digest-pinned, read-only; tool descriptions and outputs fenced; per-task and per-agent caps; drift refused | A fence reduces, but does not remove, prompt-injection influence on the model |
| Templated connector tools (CoinGecko) | The approval pins the template code digest and the upstream `execute` digest; agents send only schema-checked values; code-execution tools are refused when proposed, attached or called directly | Correctness depends on the upstream `execute` tool running the submitted template as published |
| Result destinations | Owner-only routes; sealed secrets; fixed service hosts | Outputs leave the host as plain text |
| Devnet swap | Owner approval with a maximum per swap; amount bound to the request digest and priced into every cap; the wallet decodes the quoted swap before signing and records it before signing; the relayer accepts one exact transaction shape and rechecks the sponsor cap | Current hardened path not run on devnet; three older-path swaps finalized on 17–18 October. Sponsor capacity is not reserved at funding time; a failed swap's sponsor fee does not reach control's record |
| Reference image | Owner-only; type and size checked; stored apart from the task input so the runner never receives it | The style text the agent gets is model output and is treated as untrusted |

## Permission tiers

| Mode | Behavior | Boundary |
|---|---|---|
| Observe | Propose a plan and resource purchases | No spending proof or signature is released |
| Bounded automatic | Execute purchases that satisfy every applicable rule | All task, agent and workspace limits still apply |
| Approval required | Obtain explicit owner approval for a permitted purchase | Approval cannot override hard limits |
| Stopped | Reconcile existing operations | No new spending authority; recovery uses a separate owner-authorized path |

## Enforcement boundaries

| Layer | Security responsibility |
|---|---|
| Owner control | Authenticate actions, bind worker scope, check policy versions and reserve budgets atomically |
| Wallet service | Protect note secrets, generate proofs locally and validate the complete merchant transaction, or the decoded swap instruction, before signing |
| Pool program | Verify proof/context, enforce value conservation, reject reused nullifiers and bind owner exits |
| Gateway | Bind quote/account/request, reconcile settlement, issue credits once and bound provider execution |
| Runner | Use restricted tools; treat retrieved content and service responses as untrusted input |

Budgets and revocation are enforced by owner-controlled services. They are not cryptographic spending caps. The model cannot expand its policy, access secrets, sign arbitrary transfers or authorize external publishing.

## Authentication and secret isolation

Owner sessions require a domain-bound wallet challenge with nonce, expiry and replay protection. Browser mutations require CSRF defenses. Worker credentials bind workspace and agent independently of IDs supplied in request bodies. Control separately validates each supplied task against that agent/workspace; the bearer credential itself is not task-scoped.

Keep note databases, decryption keys, signer material and provider credentials inaccessible to the agent runner. Restrict internal endpoints by credential and process boundary. Do not log private witnesses, authorization headers or secret values.

## Concurrency and recovery

Reserve all applicable allowances and the input note in one control transaction. Keep released proofs and unsettled signatures counted as live exposure. Reconcile an existing operation before issuing replacement authority. Persist payment and service-delivery outcomes separately.

## Administration and setup

The deployment manifest records upgrade, approval and sponsorship authorities. The upgrade authority can replace code; the approved-root authority can restrict private spending. The program has no sweep instruction, and owner public exit does not require approved membership. A common operator can control multiple roles; separate public keys do not prove independent operators. The current deterministic development setup has derivable toxic waste and is for test funds only.

## Verification

A security design describes required behavior; it does not establish that an implementation has passed a security review. Evaluate the [verification requirements](./evidence.md) against the exact application version and deployed artifacts. See [trust and risk boundaries](./risks.md) for residual limitations.
