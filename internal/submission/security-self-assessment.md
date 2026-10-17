# Security self-assessment

**Document date:** 15 October 2026 · **Assessment state:** design review draft, execution pending.

## Scope and conclusion

This is the team's assessment structure for Veilo's permission tiers, financial/privacy boundaries and known risks. It is not an independent audit, penetration test or certification. None of the product controls below have been verified against a completed implementation.

A documented control does not establish that it works. Historical ordinary x402 evidence is recorded separately. Current conclusion: **insufficient implementation evidence to claim security readiness**.

| Review field | Current value |
|---|---|
| Assessment scope | Agent permissions, financial controls, private payments, service delivery and recovery |
| Application version assessed | Pending implementation review |
| Deployed program / circuit manifest | Not supplied |
| Environment | Proposed Solana devnet, local single-owner services |
| Reviewers / execution date | To be assigned when implementation is ready |
| Verified product controls | None in this review |
| Open evidence | Every case in the evidence matrix |

## Assets and threat actors

Protect test-token principal, note secrets, signing/encryption keys, owner policy authority, provider credentials/real-dollar quota, ledger integrity and private prompts/results. Consider malicious service responses, prompt injection, impersonating workers, concurrent/replayed requests, compromised gateway/relayer/indexer, host compromise and buggy or malicious circuits/setup/program authorities.

## Permission-tier implementation review

| Tier | Expected enforcement | Required code evidence | Required behavioral evidence | Status |
|---|---|---|---|---|
| Observe | No financial proof/signature release | Tool surface and wallet authorization guard | Request a purchase; confirm no authority released | Not verified |
| Bounded automatic | All caps, service bindings and current epoch checked independently | Atomic reservation plus wallet rechecks | Allowed purchase succeeds; over-budget and wrong recipient fail | Not verified |
| Approval required | Owner-bound approval for exact permitted operation | Authenticated approval/digest binding and hard-cap checks | Missing/replayed/changed approval fails; valid one cannot override caps | Not verified |
| Stopped | No new spending authority; existing exposure reconciled | Serialized revoke/release boundary, epoch checks | Race stop with proof and merchant signing; report already released authority | Not verified |

See [policy](../guide/policy.md). No tier allows agents to change their policy, sign arbitrary transfers or publish externally.

## Control review areas

| Area | Design control | Verification requirement |
|---|---|---|
| Owner/worker authentication | Domain/nonce/expiry-bound wallet session, scoped credentials, CSRF defenses | Session replay, forged agent identity and cross-account retrieval tests |
| Policy / concurrency | Integer accounting, one control writer, atomic reservations | Agent races, old unresolved reservations, lowered limits |
| ZK / program | Real verifier, bound context, nullifiers, authenticated roots, checked value conservation | Real valid proofs plus invalid proof/input/root/replay/exit tests |
| x402 / gateway | Complete instruction verification, immutable quote, signature uniqueness | Wrong transfer/fee payer, request mutation, retry and expired-quote cases |
| Credits / provider | Issued-once packs, scoped single-use usage permits, real cost bounds | Replay, inter-database failure, exhausted quota and ambiguous provider request |
| Secret handling / privacy | Runner isolation, local prover, minimal redacted logs, encrypted backup | File/credential access checks, export inspection and restore with pending spend |
| Administration | Separate documented upgrade/approved-set powers | Inspect deployed authorities and prove valid owner exit without approval |

## Evidence standard

Every verified entry must include tested commit, environment, exact command/scenario, expected/observed results, UTC time, reviewer, artifact links, relevant transaction signatures, failures/skips and redaction review. A screenshot alone cannot prove concurrency safety, proof soundness or restart recovery.

Use the [evidence matrix](./security-evidence.md) as the working register and [known risks](./known-risks.md) for residual risk. Mark passes only after inspecting their artifacts. Failed, skipped or mock-only cases remain visible.

## Sign-off gate

Before freezing the submission: reconcile docs with actual code/deployment; fill tier code references; execute acceptance and negative tests; check real proof and devnet signatures; record unresolved findings/mitigations; assign reviewer and reviewed commit; retain the unaudited/prototype and metadata caveats.

This report should be exported with the final source/evidence snapshot. A new commit or different artifact set may invalidate earlier results.
