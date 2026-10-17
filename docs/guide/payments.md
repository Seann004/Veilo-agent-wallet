# Payment lifecycle

**Verification scope:** see [current status](./status.md). The recorded M2 proof run is **verified on devnet**; integrated flows are **verified on local test validator** with a **fixture / mock provider**. Full devnet agent acceptance lacks complete evidence here. Marketplace acceptance is **not yet run** in this checkout.

The private withdrawal and x402 merchant payment are separate transactions. A fresh payment wallet uses ordinary x402; x402 alone does not hide the source of funds.

<script setup>
import payment from '../diagrams/payment.mmd?raw'
</script>

<Diagram :source="payment" caption="Intended purchase swimlane. Settlement and delivery are separate facts; an unknown outcome remains unresolved." />

## Before a purchase

1. Verify devnet genesis, mint owner/decimals, token program, deployment manifest and compatible proof artifacts. Reject mainnet in demo mode.
2. The owner signs a deposit. Track submitted, finalized, indexed, approved and spendable separately. Pending or unapproved notes are unavailable.
3. Control authenticates the requester, creates a stable operation and request digest, and obtains an immutable gateway quote.
4. In one atomic control transaction, check every allowance scope and reserve input note/exposure. A second agent cannot spend that same note or last available allowance.

## Private funding

The wallet service persists a fresh signer before funding it. A local real proof demonstrates note and approved-label membership, valid nullifier, range-checked value/change and an intent bound to pool/program, devnet, mint, payout account, amount, fees, relayer where applicable and expiry.

The on-chain program verifies this proof, consumes the input nullifier, transfers only the bound amount and queues private change atomically. Change becomes spendable only after authenticated insertion finalizes and the witness is rebuilt. The indexer cannot authorize arbitrary tree roots.

The relayer/sponsor funds permitted account creation and fees under separate limits. Sponsorship must not quietly fall back to the identifiable owner's withdrawal fee payment.

## Merchant payment and delivery

The wallet validates the full x402 V2 exact transaction: network, mint, amount, recipient ATA, transfer authority, fee payer, expiry, compute budgets and allowed instruction layout. Reject unrelated transfers, approvals and delegate changes.

The gateway validates the immutable quote/account/request binding and atomically claims the operation and signature before settlement. After finalized settlement, it records one financial event and either issues a credit pack once or authorizes one bounded service attempt. Paid retries return the existing status/result even after quote expiry.

| Payment option | Financial effect |
|---|---|
| Direct per-call x402 | One test-USDC payment; no prepaid debit |
| Credit-pack purchase | One test-USDC payment attributed to Shawn; one gateway issuance |
| Prepaid inference | Consume shared gateway credits and requesting agent usage allowance; no second USDC charge |

Mira's scripted demo uses a **direct private x402 content-package purchase**; its local-validator rehearsal uses a **fixture / mock provider**. A later devnet gateway run is reported on the deployment branch, but Mira's complete live result/receipt evidence is missing here. Shawn demonstrates shared-credit replenishment; Prince may use the prepaid path.

## Marketplace settlement — required, not implemented here

A marketplace quote must bind the reviewed listing, runtime and payout versions, exact seller recipient, scope, network, mint, amount and expiry. The fresh signer pays that seller directly through x402 V2 exact. Execution waits for independently verified finality unless the quote is explicitly free. Quotes/receipts show a zero platform fee; seller earnings are finalized receipt history, not a platform balance. Gateway credits do not replace direct seller settlement.

The current gateway has one configured merchant. Managed paid listings stay blocked until per-listing recipients and receipt-to-job uniqueness are implemented and verified; do not route seller funds through the operator. One finalized receipt may fund one job and one earnings event. Refunds are separate seller-funded, finalized transfers to an owner-verified destination, cumulatively capped at the settled amount; failed delivery must remain visibly paid. These are [v3.2 requirements](./marketplace.md), not evidence that marketplace settlement/refunds work.

## Recovery and failure handling

| Boundary | Required handling |
|---|---|
| Proof released, withdrawal outcome unknown | Keep exposure reserved; reconcile nullifier/chain state and proof expiry |
| Withdrawal finalized, merchant not signed | Track the funded wallet separately from pool notes; resume only within current policy |
| Merchant signed/submitted, response lost | Query the existing signature; do not automatically create another payment |
| Settlement finalized, issuance interrupted | Reconcile and issue the same pack once |
| Provider request outcome unknown | Record uncertain or paid-without-result; no blind retry without upstream idempotency |
| Agent stopped with a funded wallet | Recover only to the configured owner destination after conflicting authority is resolved |

Quote expiry, transaction last-valid block height and proof `valid_until_slot` are different bounds. Expiring a transaction does not necessarily invalidate a released proof that can be placed in another transaction. Release its reservation only after finalized chain evidence proves the authorization is no longer usable and no spend settled.

A public exit requires note ownership proof and the original refund authority. It must remain possible without approved-set membership; it reveals information and does not restore privacy. Test both original and change notes.
