# Trust and risk boundaries

**Verification scope:** see [current status](../guide/status.md). The recorded M2 proof run is **verified on devnet**; integrated flows are **verified on local test validator** with a **fixture / mock provider**. The Shawn/Prince/Mira demo has one recorded pre-merge **verified on devnet** run with live inference. Marketplace code is on `main`; a private-pool-funded hire is **not yet run** on devnet.

| Boundary | Risk | Design response |
|---|---|---|
| Owner host and wallet | Compromise exposes notes or bypasses local spending policy | Isolated credentials/processes, constrained signer, encrypted backups with writers quiesced for an operator snapshot |
| Circuits and verifier | Incorrect constraints/encodings can compromise the pool; current deterministic development setup has derivable toxic waste | Devnet test funds only; pinned artifacts and local positive/negative proof tests do not replace a production ceremony or independent review |
| Pool metadata | Small pools and distinctive amounts/timing enable correlation | Explain public information and avoid treating membership size as an anonymity score |
| Program administration | Upgrade authority can change enforcement; approved-root authority can restrict private spending | Disclose powers separately and preserve owner exit without approved membership |
| Released authority | Proofs or signed transactions may settle after a stop | Track live exposure until settlement or proven expiry; recheck before release |
| Gateway and provider | Accounts, requests and prompts permit off-chain linkage | Minimize metadata and retention; authenticate result access; disclose visibility |
| External execution | A settled payment may have an uncertain or missing service result | Persist execution state and cache results; avoid blind provider/payment retries |
| Backup and restore | Lost change or reused wallet material can lose funds or duplicate authority | Wallet/control snapshots are separate and omit the gateway ledger; quiesce writers, retain matching gateway state/credentials and reconcile after restore |
| Dependencies | Devnet, RPC, facilitator or provider outages interrupt work | Health checks, bounded retries/cost and explicit pause states |
| Public exit/recovery | Reveals value or linkage | Use bound owner destinations and explain the public nature of the operation |

Independent review and execution evidence are needed to evaluate implementation safety. Privacy depends on correct cryptography and operational behavior; it does not hide every transaction detail from every observer.

## Submission and licensing

Organizer acceptance of devnet/reuse remains unresolved. Veilo’s own license is an owner decision; GPL prover/hash components and the verifier’s MIT-metadata/Apache-license-file discrepancy require review. See [attribution](../references/attribution.md) and [handoff](../handoff.md).

## Marketplace risks — controls in code, devnet acceptance incomplete

| Boundary | Required response / current gap |
|---|---|
| Cloud identity and private jobs | Separate marketplace and local sign-in. Tenant RLS and private Storage pass the live RLS e2e script (84/84); wallet-switching ownership is not specifically tested. |
| Cloud-to-local connection | No cloud spending authority; control connects outbound and signs every request (replay refused). Offline pause follows from local approval but no offline drill is recorded. |
| Seller recipient and earnings | Seller-host profile pays each listing's payout address; one-receipt/one-job is enforced in the database. Verified on devnet only with a publicly funded payer. |
| Delivery and refunds | Direct prepayment provides no escrow or automatic refund guarantee. Paid failures stay visible; seller-funded finalized refunds need destination and cumulative-amount checks. |
| Hosted jobs and connectors | No hosted sandbox/credential broker is established by local process separation. Limit attempts/egress/grants; reject stale leases and forged callbacks; prevent result files executing scripts. |
| Privacy and retention | Operator/sellers/providers see plaintext processed jobs and buyer–seller links. Signed downloads are checked; required 30-day cleanup is not implemented; RLS is not metadata anonymity. |

See [marketplace triage](../guide/marketplace-triage.md) for exact closure evidence. Marketplace inclusion and Supabase adoption have already been approved; remaining engineering gates are not reasons to describe them as out of scope.
