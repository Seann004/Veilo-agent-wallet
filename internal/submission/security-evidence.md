# Security evidence matrix

**Execution state: every case is not run.** The cases cover financial controls, private payments, recovery, agent permissions, sessions, process isolation and deployment artifacts. Listed requirements are not executed tests.

Download the [CSV working register](/security-evidence.csv). Fill its commit, environment, reviewer, command/scenario, observed result, artifact links and timestamp fields when testing. Use `pass` only with evidence; preserve `fail`, `blocked` and `not-run`. A mock verifier does not pass privacy acceptance.

| Case | Scenario | Expected evidence / result | Status |
|---|---|---|---|
| NET-01 | Mainnet/wrong mint config | Startup and payment reject | Not run |
| X402-01 | Exact ordinary payment | Devnet settlement plus real bounded inference | Not run |
| X402-02 | Wrong amount/ATA/authority/fee payer/instruction | Complete verifier rejects | Not run |
| X402-03 | Same signature on another quote/account | No second fulfilment or credit issuance | Not run |
| X402-04 | Same operation with changed request | 409 conflict, no charge | Not run |
| PRIV-01 | Valid spend and change | On-chain real proof accepted; change note spendable | Not run |
| PRIV-02 | Bad proof/context/public input | No release of value | Not run |
| PRIV-03 | Same nullifier twice | Second spend/exit rejected | Not run |
| PRIV-04 | Underflow/wrapped values/wrong root | Rejected; no invented balance | Not run |
| PRIV-05 | Forged insertion/genesis/duplicate precommitment | Rejected or authenticated queue invariant preserved | Not run |
| PRIV-06 | Unapproved original and change owner exit | Private pay rejected when required; valid public exit works | Not run |
| PRIV-07 | Multiple labeled test deposits | No explicit spent-deposit identifier in withdrawal; metadata caveats documented | Not run |
| CAP-01 | Per-purchase/task/agent/global cap | No proof/signature released beyond any cap | Not run |
| CAP-02 | Two agents race for final allowance | Atomic authorization admits only permitted exposure | Not run |
| CAP-03 | Uncertain payment crosses rolling window | Reservation still counts | Not run |
| CAP-04 | Lower limit below pending exposure | New spend blocked, exposure visible | Not run |
| REV-01 | Pause before signing / proof released | New authority blocked; released material handled honestly | Not run |
| AUTH-01 | Agent passes another agent ID | Scope mismatch rejected | Not run |
| AUTH-02 | Role tries arbitrary sign/policy edit/publish | Tool unavailable or independently denied | Not run |
| IDEM-01 | Same logical purchase repeatedly | One financial operation; same state/result | Not run |
| REC-01 | Restart at every multi-leg boundary | Notes/keys/credits/reservations restored and reconciled | Not run |
| REC-02 | Lost settlement response | Reconcile existing signature; no blind new debit | Not run |
| REC-03 | Fresh-wallet recovery conflicting with signed tx | Wait for proven safe outcome; only owner destination | Not run |
| CRE-01 | Restart after settle before issue | Issue pack once | Not run |
| CRE-02 | Two usage requests over available credits | One bounded outcome; no negative credits | Not run |
| CRE-03 | Shawn sees low credits repeatedly | One unresolved top-up; cooldown/caps hold | Not run |
| CRE-04 | Usage permit replay/modified digest | No second debit/inference | Not run |
| CRE-05 | Top-up then consumption dashboard | No double-counted USDC expenditure | Not run |
| LLM-01 | Upstream timeout/price change/exhausted account | Fail closed or visible uncertain outcome; no uncontrolled retry | Not run |
| AGT-01 | Prince service choice | Useful brief and attributable purchased evidence | Not run |
| CNT-01 | Mira from approved handoff | Direct private devnet x402 signature, real inference, three editable drafts and seven-day calendar | Not run |
| CNT-02 | Edit/approve/calendar change | No hidden charge or external publish | Not run |
| SEC-01 | Malicious service asks for funds/policy change | Independent rejection; no reliance on model refusal | Not run |
| SEC-02 | Prompt/log inspection | No secret notes, keys or sensitive auth material | Not run |
| BAK-01 | Restore backup with pending spend | No address reuse, duplicate purchase or lost change | Not run |
| LED-01 | Pending change and external recovery | Change unavailable before insertion; external recovered principal creates no pool note | Not run |
| EXIT-01 | Attacker signer with valid note proof | Derived label mismatch rejects; correct owner original/change exit succeeds | Not run |
| EXP-01 | Old proof in fresh-blockhash tx after bound | Clock/context check rejects; no premature reservation release | Not run |
| QUO-01 | Accepted tx settles after quote expires | Honor original price once; paid retries return cached result | Not run |
| QUO-02 | Re-quote funded operation | Existing funding reused/recovered; no second automatic withdrawal | Not run |
| USG-01 | Failure between scoped/account reservation | Reconcile same operation; no double debit or excess consumption | Not run |
| TIER-01 | Observe tier requests purchase | No spending proof/signature released | Not run |
| TIER-02 | Approval missing, changed or replayed | Reject; valid approval still cannot override hard caps | Not run |
| SESS-01 | Wallet challenge replay, wrong domain, expired session, CSRF | Reject unauthenticated mutations and session replay | Not run |
| AUTH-03 | Different workspace retrieves cached paid result | Reject cross-account access even with transaction signature | Not run |
| ISO-01 | Runner reads note/provider secrets or arbitrary signing endpoint | Process/credential isolation denies access | Not run |
| ART-01 | Proving/verifying artifact or manifest mismatch | Stop proof/payment generation | Not run |
| ADMIN-01 | Inspect deployed upgrade and approved-set authority | Separate public authority mapping matches manifest; powers disclosed | Not run |

## Reading the results

Each case must point to a reviewed [evidence record](./execution.md), relevant code/commit, and actual output. Do not infer the full matrix passed from an unrelated green CI run. Report the number passed/failed/skipped and the exact environment. For real proof cases, pin deployed verifier/artifact hashes and include positive and negative results.

The documentation CI only builds this website. It does not execute these product tests.
