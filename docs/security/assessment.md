# Security model

Veilo separates agent planning, owner authority, wallet signing, on-chain verification and paid-service delivery. An agent request alone is never sufficient authority to release funds.

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

Owner sessions require a domain-bound wallet challenge with nonce, expiry and replay protection. Browser mutations require CSRF defenses. Worker credentials bind workspace, agent and task scope independently of IDs supplied in request bodies.

Keep note databases, decryption keys, signer material and provider credentials inaccessible to the agent runner. Restrict internal endpoints by credential and process boundary. Do not log private witnesses, authorization headers or secret values.

## Concurrency and recovery

Reserve all applicable allowances and the input note in one control transaction. Keep released proofs and unsettled signatures counted as live exposure. Reconcile an existing operation before issuing replacement authority. Persist payment and service-delivery outcomes separately.

## Verification

A security design describes required behavior; it does not establish that an implementation has passed a security review. Evaluate the [verification requirements](./evidence.md) against the exact application version and deployed artifacts. See [trust and risk boundaries](./risks.md) for residual limitations.
