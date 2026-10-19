# Security self-assessment

Veilo separates agent planning from spending authority. This is a team self-assessment of the devnet prototype, not an independent audit. [Current status](../guide/status.md) and [execution evidence](../evidence.md) record what has been tested.

## Permission tiers

| Mode | Allowed behavior |
|---|---|
| Observe | Propose work; release no spending proof or signature |
| Bounded automatic | Execute only within all owner-approved limits and grants |
| Approval required | Obtain owner approval; hard limits still apply |
| Stopped | Reconcile existing operations; issue no new spending authority |

## Enforcement

| Component | Responsibility |
|---|---|
| Local control | Authenticate requests, bind agent/workspace scope, reserve budgets atomically and enforce revocation |
| Local wallet | Encrypt notes and signing material, generate proofs, validate the complete payment or swap before signing |
| Solana pool | Verify proof/context, conserve value, reject duplicate nullifiers and bind payout/owner-exit destinations |
| Gateway | Bind quotes and requests, reconcile settlement, issue credits once and cache results |
| Marketplace | Isolate tenant records, protect quote/recipient versions, enforce one receipt per job and reject stale worker leases |
| Agent runner | Use restricted tools; treat third-party descriptions, pages and results as untrusted |

Owner sign-in uses a domain-bound wallet challenge with nonce and expiry. Browser mutations require CSRF protection. Worker credentials and internal service credentials have separate scopes. Marketplace sign-in never grants spending authority.

Note secrets, signer material and provider keys remain outside runner-readable state. Model keys are sealed locally. Browsing restricts public destinations, request size and page count. MCP tools require review and digest pins; raw code-execution tools are refused. These controls reduce exposure but do not eliminate prompt injection.

## Recovery and administrative trust

Released proofs and signed transactions count as live exposure until settlement or proven expiry. Retries reconcile the existing operation before issuing new authority. Backup restore requires matching wallet/control/gateway state and reconciliation.

The owner host is trusted. Budgets are service-enforced, not proof-enforced. Program upgrades can change enforcement; approval authorities can restrict private spending. Owner exit is independent of approved membership. The deterministic proof setup is suitable only for devnet test funds.

See [known risks](./risks.md) and [verification requirements](./evidence.md) for the remaining work. No claim of mainnet readiness, universal anonymity or independently reviewed security is made.
