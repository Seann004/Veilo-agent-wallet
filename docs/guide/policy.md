# Policy and accounting

For recorded verification and remaining checks, see [current status](./status.md).

## Permission tiers

| Tier | Permitted behavior | Still prohibited |
|---|---|---|
| Observe | Plan and explain proposals | Releasing spending proofs/signatures |
| Bounded automatic | Purchase without another approval when every applicable rule passes | Exceeding any cap or allowed service binding |
| Approval required | Request explicit owner approval for designated valid purchases | Using approval to bypass hard limits |
| Stopped | Reconcile existing operations | Releasing new spending authority |

Recovery and owner exit remain available through their separate authenticated paths. Editing policy is a distinct owner action. Structured policy changes create drafts that require owner activation. The dashboard can pre-fill limit fields from a plain-language description using a deterministic parser; it saves nothing by itself. Guests and the public viewer cannot edit policy.

## Marketplace approval and offline control

Specialist hiring keeps every local limit in force for specialist hires. A cloud identity session or cloud policy record cannot authorize spending: local control must install/acknowledge policy proposals and validate an approved seller plus immutable listing/payout/quote/runtime versions. A changed recipient or unapproved seller must stop locally. Concurrent hires share the same local allowance authority.

The required cloud connection uses authenticated, digest-bound, expiring requests initiated outbound by local control. New automatic spending pauses when control is offline; already released authority remains live exposure. Local approval bound to the operation, quote digest, recipient and total, owner-installed listing grants, concurrent-cap checks and revocation are implemented and unit-tested against fakes; lease and callback rules pass the live RLS e2e script. An offline-controller drill and a devnet run of these paths are still outstanding. See [triage](./marketplace-triage.md).

## Authorization algorithm

1. Authenticate the worker's bound workspace/agent, and validate supplied task ownership; do not trust an agent ID supplied in JSON.
2. Resolve the stable operation and immutable request/quote. Changed payload for the same operation conflicts before any payment.
3. Validate service origin, gateway identity, SKU, network, mint, recipient and quote bounds.
4. In a single `BEGIN IMMEDIATE` transaction, recheck limits, status, policy version and note availability; create the unique operation/reservation.
5. Recheck policy and revocation epoch before proof release, withdrawal submission and merchant signing.
6. Reconcile finalized outcomes into durable financial events. Keep unknown outcomes reserved.

All writers use the same control authority/database. Multiple worker databases each checking their own caps cannot enforce a workspace cap.

## Independent limits

Every purchase must pass per-purchase, per-task lifetime, per-agent lifetime and rolling 24-hour, workspace lifetime and rolling 24-hour limits. Sponsor SOL fees and recoverable rent have separate bounds. Gateway usage has both scoped usage allowances and shared available credits.

Use integer amounts and decimal strings across APIs. Never compare financial amounts using floating point.

For each cash scope:

```text
available = limit - applicable settled cost - all active reservations
```

For rolling scopes, count settled costs within the preceding 24 hours **plus every live reservation**, even if it is older. A reservation crossing midnight or a rolling boundary does not release exposure.

For gateway credits:

```text
usable credits = issued - consumed - reserved
```

Cash spent, pool tokens, funded fresh-wallet principal, pending change, sponsor lamports, prepaid credits and provider dollars are different units/states. Never sum them into a single balance.

## Revocation and restoration

Pause/revoke must serialize against financial authority release. Already released proof/transaction material may settle until its bound expires; display that live exposure. Do not promise cancellation after release.

Recovering proven unpaid principal may restore eligible allowance. It does not refund a completed service or paid fees, and an external recovered balance does not create a private pool note. Re-entering the pool requires a new deposit.

Persist original settlement timestamps. A restart must not move old spending into a different window. Link refunds to their original expense; an expired expense cannot offset unrelated new rolling-window spending.
