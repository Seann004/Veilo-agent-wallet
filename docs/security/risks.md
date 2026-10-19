# Known risks

Veilo is an unaudited devnet prototype. These limits apply even when a transaction succeeds.

| Risk | Current boundary |
|---|---|
| Development proof setup | Deterministic setup has derivable toxic waste; use test funds only. Production requires suitable setup and independent review. |
| Trusted owner host | Compromise can expose notes/keys and bypass local budgets. Encryption at rest does not protect a compromised running service. |
| Public metadata | Deposits, payouts, amounts, merchant transfers, fees and timing remain public. Small pools provide weak privacy. |
| Administrative control | Upgrade authority can replace enforcement; approved-root authority can restrict private spending. Distinct keys do not prove independent operators. |
| Released payments | Pause/revoke stops new authority; already released transactions may settle. Uncertain operations require reconciliation. |
| Providers and prompts | Operators, sellers and model providers can see processed content and relationships. Restricted tools do not eliminate prompt injection. |
| Delivery and refunds | Direct prepayment is not escrow. Payment can succeed while delivery fails; refunds depend on seller action and chain verification. |
| Recovery | Missing change, inconsistent backups or reused signer material can lose funds or duplicate authority. Restore matching state and reconcile. |
| Swaps | Sponsor budget can be exhausted after pool funding. SOL delivered to the owner's public address creates a visible link. |
| Hosting and retention | Local process separation is not a hosted sandbox. Credential brokering and automatic content-retention cleanup are not implemented. |
| Availability | RPC, facilitator and provider outages can pause work or leave uncertain outcomes. Retries must remain bounded. |

[Current status](../guide/status.md) identifies pending live checks. [Dependency notices](../references/attribution.md) retain license-review gaps. Historical receipts and local tests do not establish production safety.
