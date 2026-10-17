# Security model

**Verification scope:** see [current status](../guide/status.md). The recorded M2 proof run is **verified on devnet**; integrated flows are **verified on local test validator** with a **fixture / mock provider**. Full devnet agent acceptance lacks complete evidence here. Marketplace acceptance is **not yet run** in this checkout.

Veilo separates agent planning, owner authority, wallet signing, on-chain verification and paid-service delivery. An agent request alone is never sufficient authority to release funds.

## Assessment scope and conclusion

Team self-assessment of source snapshot `fe13778`, reviewed against the recorded evidence on 17 October 2026. M2 demonstrates the proof-based devnet funding rail; local integration reports 30/30 cases with mock inference. Neither establishes live agent inference, a completed submission gate, an independent audit or production safety. Permission tiers below are implemented controls with local test coverage; full devnet agent acceptance is **not yet run**.

Assets include test-token principal, note/signing/encryption secrets, owner authority, provider quota, ledger integrity and private prompts. Threat actors include malicious services/prompts, impersonating workers, replaying/concurrent callers, compromised gateway/relayer/indexer, hostile host access and faulty circuits/setup/program administrators.

## Marketplace threat and authority extension — pending

The accepted v3.2 design adds independent buyers/sellers and Supabase identity/product records while keeping one owner per workspace. Cloud sign-in is separate from the existing local challenge and never releases spending authority. RLS, explicit grants, sanitized public catalogue projections and private participant Storage are required; direct client writes to quote/job/payment/earnings state are prohibited. Service keys stay server-side. These cloud controls are not implemented or tested here.

New threats include cross-tenant reads, forged seller callbacks, payout/version substitution, duplicate receipt attribution, stale workers, malicious result files and compromised hosted execution. The local runner’s restricted tools do not establish a hosted sandbox. The operator/seller/provider can see job content and relationships. [All 14 marketplace acceptance checks](../guide/marketplace-triage.md) remain open; existing CAP/IDEM/REC results are supporting local foundations only.

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
| Wallet service | Protect note secrets, generate proofs locally and validate the complete merchant transaction before signing |
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
