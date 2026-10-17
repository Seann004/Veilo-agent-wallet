# Payment lifecycle

**Verification scope:** see [current status](./status.md). M2 only is **verified on devnet**; integrated flows are **verified on local test validator** with a **fixture / mock provider**. The integrated devnet agent demo is **not yet run**.

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

Mira's scripted demo uses a **direct private x402 content-package purchase**; this has run on the local test validator with a **fixture / mock provider**, and its devnet run is **not yet run**. Shawn demonstrates shared-credit replenishment; Prince may use the prepaid path.

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
