# Trust and risk boundaries

**Verification scope:** see [current status](../guide/status.md). M2 only is **verified on devnet**; integrated flows are **verified on local test validator** with a **fixture / mock provider**. The integrated devnet agent demo is **not yet run**.

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
