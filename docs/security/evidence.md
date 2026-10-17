# Verification requirements

**Verification scope:** see [current status](../guide/status.md). The recorded M2 proof run is **verified on devnet**; integrated flows are **verified on local test validator** with a **fixture / mock provider**. Full devnet agent acceptance lacks complete evidence here. Marketplace acceptance is **not yet run** in this checkout.

Use these acceptance scenarios to evaluate the security and reliability of an implementation. Each result should identify the application version, environment, reproducible scenario, observed behavior and relevant artifacts. The matrix below defines expected outcomes. Recorded coverage is mapped separately; a row alone is not a passing result.

| Case | Scenario | Expected evidence / result |
|---|---|---|
| NET-01 | Mainnet/wrong mint config | Startup and payment reject |
| X402-01 | Exact ordinary payment | Devnet settlement plus real bounded inference |
| X402-02 | Wrong amount/ATA/authority/fee payer/instruction | Complete verifier rejects |
| X402-03 | Same signature on another quote/account | No second fulfilment or credit issuance |
| X402-04 | Same operation with changed request | 409 conflict, no charge |
| PRIV-01 | Valid spend and change | On-chain real proof accepted; change note spendable |
| PRIV-02 | Bad proof/context/public input | No release of value |
| PRIV-03 | Same nullifier twice | Second spend/exit rejected |
| PRIV-04 | Underflow/wrapped values/wrong root | Rejected; no invented balance |
| PRIV-05 | Forged insertion/genesis/duplicate precommitment | Rejected or authenticated queue invariant preserved |
| PRIV-06 | Unapproved original and change owner exit | Private pay rejected when required; valid public exit works |
| PRIV-07 | Multiple labeled test deposits | No explicit spent-deposit identifier in withdrawal; metadata caveats documented |
| CAP-01 | Per-purchase/task/agent/global cap | No proof/signature released beyond any cap |
| CAP-02 | Two agents race for final allowance | Atomic authorization admits only permitted exposure |
| CAP-03 | Uncertain payment crosses rolling window | Reservation still counts |
| CAP-04 | Lower limit below pending exposure | New spend blocked, exposure visible |
| REV-01 | Pause before signing / proof released | New authority blocked; released material handled honestly |
| AUTH-01 | Agent passes another agent ID | Scope mismatch rejected |
| AUTH-02 | Role tries arbitrary sign/policy edit/publish | Tool unavailable or independently denied |
| IDEM-01 | Same logical purchase repeatedly | One financial operation; same state/result |
| REC-01 | Restart at every multi-leg boundary | Notes/keys/credits/reservations restored and reconciled |
| REC-02 | Lost settlement response | Reconcile existing signature; no blind new debit |
| REC-03 | Fresh-wallet recovery conflicting with signed tx | Wait for proven safe outcome; only owner destination |
| CRE-01 | Restart after settle before issue | Issue pack once |
| CRE-02 | Two usage requests over available credits | One bounded outcome; no negative credits |
| CRE-03 | Shawn sees low credits repeatedly | One unresolved top-up; cooldown/caps hold |
| CRE-04 | Usage permit replay/modified digest | No second debit/inference |
| CRE-05 | Top-up then consumption dashboard | No double-counted USDC expenditure |
| LLM-01 | Upstream timeout/price change/exhausted account | Fail closed or visible uncertain outcome; no uncontrolled retry |
| AGT-01 | Prince service choice | Useful brief and attributable purchased evidence |
| CNT-01 | Mira from approved handoff | Direct private devnet x402 signature, real inference, three editable posts and seven-day calendar |
| CNT-02 | Edit/approve/calendar change | No hidden charge or external publish |
| SEC-01 | Malicious service asks for funds/policy change | Independent rejection; no reliance on model refusal |
| SEC-02 | Prompt/log inspection | No secret notes, keys or sensitive auth material |
| BAK-01 | Restore backup with pending spend | No address reuse, duplicate purchase or lost change |
| LED-01 | Pending change and external recovery | Change unavailable before insertion; external recovered principal creates no pool note |
| EXIT-01 | Attacker signer with valid note proof | Derived label mismatch rejects; correct owner original/change exit succeeds |
| EXP-01 | Old proof in fresh-blockhash tx after bound | Clock/context check rejects; no premature reservation release |
| QUO-01 | Accepted tx settles after quote expires | Honor original price once; paid retries return cached result |
| QUO-02 | Re-quote funded operation | Existing funding reused/recovered; no second automatic withdrawal |
| USG-01 | Failure between scoped/account reservation | Reconcile same operation; no double debit or excess consumption |
| TIER-01 | Observe tier requests purchase | No spending proof/signature released |
| TIER-02 | Approval missing, changed or replayed | Reject; valid approval still cannot override hard caps |
| SESS-01 | Wallet challenge replay, wrong domain, expired session, CSRF | Reject unauthenticated mutations and session replay |
| AUTH-03 | Different workspace retrieves cached paid result | Reject cross-account access even with transaction signature |
| ISO-01 | Runner reads note/provider secrets or arbitrary signing endpoint | Process/credential isolation denies access |
| ART-01 | Proving/verifying artifact or manifest mismatch | Stop proof/payment generation |
| ADMIN-01 | Inspect deployed upgrade and approved-set authority | Separate public authority mapping matches manifest; powers disclosed |

## Recorded coverage

| Source | Observed scope | Status / limit |
|---|---|---|
| [M2 files](https://github.com/Seann004/Veilo-agent-wallet/blob/fe13778/artifacts/evidence/m2-summary.json) | Deploy, two deposits/inserts, approval, spend, change insert, Echo merchant and original/change exits | **verified on devnet**. PRIV-01/PRIV-07/EXIT happy paths only; no full negative matrix or agent control integration implied. |
| [Integration JSON](https://github.com/Seann004/Veilo-agent-wallet/blob/fe13778/artifacts/evidence/integration-2026-10-17T00-36-54-669Z.json) | 30/30 passed; IDEM-01, X402-03/04, REC-01/02/03, CRE-01/03, USG-01, LLM-01, QUO-01/02, LED-01, CAP-02, BAK-01, REV-01, SEC-02 | **verified on local test validator**; **fixture / mock provider**. X402-01 is partial: local chain and mock inference cannot meet its devnet/live-inference expectation. |
| [Build status](../build-status.md) T02–T14 and source tests | Unit/LiteSVM evidence for NET, CAP, AUTH, PRIV, EXP, EXIT, TIER, SESS, ISO, ART and runner/content cases | Historical local results only; not rerun in this documentation pass. Do not describe LiteSVM as a local test validator. |
| [Demo steps](../guide/demo.md) | Shawn top-up, Prince brief, Mira direct content payment, duplicate/cap/revoke/exit recording | Complete devnet acceptance evidence is missing here; local agent rehearsal uses a **fixture / mock provider**. A parallel branch’s gateway chain record alone does not complete the gate. Funded dashboard screenshots also outstanding. |

The integration report's `environment`, `prdCoverage`, `tests`, `failedOrSkipped` and `scenarioEvidence` are the machine-readable record. Its program hash identifies the tested binary, but it does not name the tested Git commit; attach that commit and reviewer at submission freeze. The separate OpenRouter smoke is a baseline, not AGT-01/CNT-01 completion. All remaining matrix rows lack a consolidated, reviewed per-case submission record.

## Evidence quality

Use real proof artifacts and the deployed verifier for privacy checks. Include positive and negative cases, concurrency tests and deterministic restart/fault injection. A transaction signature proves a public transaction; it does not independently prove policy enforcement or correct service delivery. Keep failures and skipped checks visible in the implementation's test report.

## Marketplace acceptance is separate

PRD v3.2 adds T17–T23 and fourteen §26.6 checks. The complete [marketplace acceptance matrix](../guide/marketplace-triage.md) assigns documentation IDs MKT-01–MKT-14, specifies closure evidence and records each as **not yet run for the marketplace**. It covers identity/tenant isolation, immutable seller quotes, concurrent hires, receipt uniqueness, failure recovery, refunds, leases, malicious files, offline control and unchanged pool invariants. These are requirement labels, not passing test names.

The 30-case local P0 report does not prove Supabase RLS/Storage, a seller job, cloud/local replay handling, earnings or a hosted sandbox. A free/fixture demonstration cannot satisfy genuine devnet seller settlement. Keep marketplace evidence separate from the existing P0/M2 records and attach the exact implemented commit, environment and actors.
