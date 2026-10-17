# Known risks and unresolved findings

**Draft register — 15 October 2026.** Severity is a provisional design assessment, not a discovered exploit rating. All listed mitigations are requirements until evidence demonstrates them. Implementation and operations owners are role assignments to be confirmed by the team.

| ID | Risk / impact | Provisional severity | Required mitigation or disclosure | Owner | State |
|---|---|---|---|---|---|
| R-01 | Owner host/wallet compromise exposes notes and bypasses local caps | Critical | Separate credentials/processes; encrypt backups; restrict signer; use test funds; disclose host trust | Implementation | Open, unverified |
| R-02 | Circuit/verifier/encoding/setup flaw can release pool value incorrectly | Critical | Real proof vectors, negative tests, setup provenance and artifact pinning; specialist review before production | Protocol | Open, unverified |
| R-03 | Small pool and timing/amount correlation weaken deposit linkage privacy | High | Display pool limitations, synthetic participant labels and public metadata; avoid anonymity claims | Docs / operator | Inherent limitation |
| R-04 | Upgrade authority can change enforcement; approved-root operator can restrict private spends | High | Publish separate authority powers and test owner exit without approved membership | Protocol / operator | Open, unverified |
| R-05 | Concurrent/retried jobs overspend or charge twice | High | Atomic reservations, operation/signature uniqueness, durable reconcile and fault-injection tests | Implementation | Open, unverified |
| R-06 | Released proof or signed payment settles after stop | High | Track live exposure; slot-bound intent; recheck before release; honest UI and race tests | Implementation | Inherent race; controls unverified |
| R-07 | Payment succeeds but provider result is lost/ambiguous | Medium | Persist start/result, one automatic attempt, paid-without-result state; documented refund/recovery policy | Gateway | Open, unverified |
| R-08 | Gateway/provider sees prompts, usage/account link and network metadata | Medium | Disclose visibility/retention, minimize identifiers/logs, authenticated result retrieval and cleanup | Gateway / docs | Inherent trust boundary |
| R-09 | Public exit/recovery reveals value and linkage | Medium | Explicit owner warning, only bound owner destination, separate public/private balances | Wallet / docs | Inherent limitation |
| R-10 | Provider/facilitator/devnet outage blocks useful work | Medium | Health checks, bounded cost/time, explicit pause; validate any fallback protocol/network | Operator | External dependency |
| R-11 | Backup loss or unsafe restore loses notes/change or duplicates authority | High | Consistent encrypted snapshot; preserve counters/pending state; restore-and-reconcile test | Wallet / operator | Open, unverified |
| R-12 | Malicious tool output induces unauthorized money movement or secret access | High | Independent tool/financial checks, origin restrictions, no arbitrary signer or policy/publish tools | Runner / wallet | Open, unverified |
| R-13 | Organizer eligibility of devnet/reuse is unresolved | Submission | Confirm Solana devnet acceptance and attribution/reuse rules directly with organizers | Submission lead | External confirmation pending |

## Finding record

For a new implementation finding, record ID, affected commit/component, reproduction, expected/observed result, impact, severity rationale, owner, mitigation, patch commit and retest evidence. Link it from the relevant [test case](./security-evidence.md). Do not mark a risk closed merely because its mitigation appears in this design document.
