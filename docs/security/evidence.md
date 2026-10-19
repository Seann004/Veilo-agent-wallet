# Verification requirements

Use these checks when evaluating a release. Recorded results are on the [Evidence page](../evidence.md); outstanding product checks are in [current status](../guide/status.md). A requirement is not a passing result.

| Area | Required check |
|---|---|
| Network | Refuse mainnet, wrong mint and mismatched deployment/proving artifacts |
| Privacy pool | Accept valid spend/change; reject invalid proofs, altered intent, duplicate nullifiers and forged insertion |
| Permissions | Observe mode releases no funds; missing/replayed approval fails; all budgets hold under concurrency |
| Payment integrity | Reject altered amount/recipient/instructions; reuse one operation for retries; settle and fulfill once |
| Sessions and isolation | Reject wallet-challenge replay, CSRF, cross-workspace access and runner access to secrets |
| Revocation | Stop new authority while tracking already released proofs and signatures |
| Recovery | Reconcile lost replies and restarts without duplicate debits; restore change and signer state |
| Marketplace | Protect tenant data, immutable quotes, receipt uniqueness, worker leases, refunds and result downloads |
| Paid delivery | Pair real devnet seller settlement with the resulting output; distinguish fixtures and live providers |
| Owner withdrawal | Bind the original refund authority and verify the finalized return destination |

Every result should name the tested source, deployed program/artifacts, environment, date, scenario, expected/observed outcome and failures/skips. For payments, include the full funding and settlement signatures, amount, recipient and delivered result. Local-validator signatures must never be labelled as devnet receipts.

Unit tests, local-validator integration, live database checks and devnet transactions establish different things. None substitutes for independent security review. [Marketplace verification](../guide/marketplace-triage.md) summarizes its remaining end-to-end checks.
