# Payment lifecycle

**Verification scope:** see [current status](./status.md). The recorded M2 proof run is **verified on devnet**; integrated flows are **verified on local test validator** with a **fixture / mock provider**. The Shawn/Prince/Mira demo has one recorded pre-merge **verified on devnet** run with live inference. Marketplace code is on `main`; a private-pool-funded hire is **not yet run** on devnet.

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
| Direct per-call x402 | One USDC payment; no prepaid debit |
| Credit-pack purchase | One USDC payment attributed to Shawn; one gateway issuance |
| Prepaid inference | Consume shared gateway credits and requesting agent usage allowance; no second USDC charge |

Mira's scripted demo uses a **direct private x402 content-package purchase**; its local-validator rehearsal uses a **fixture / mock provider**. Devnet run `2026-10-17-1eba868c` (before PR #3 merged) recorded the content-package withdrawal, a 300,000-base-unit merchant leg to the Veilo gateway and a live inference receipt; see the [demo checklist](./demo.md). Shawn demonstrates shared-credit replenishment; Prince may use the prepaid path.

## Marketplace settlement

A marketplace quote must bind the reviewed listing, runtime and payout versions, exact seller recipient, scope, network, mint, amount and expiry. The fresh signer pays that seller directly through x402 V2 exact. Execution waits for independently verified finality unless the quote is explicitly free. Quotes/receipts show a zero platform fee; seller earnings are finalized receipt history, not a platform balance. Gateway credits do not replace direct seller settlement.

Managed listings settle on the seller-host gateway profile to the listing's verified payout address, never through the operator's gateway merchant. Receipt-to-job uniqueness is enforced in the database (checked in the live RLS e2e script). Two devnet smokes settled directly to a seller's payout ATA with a publicly funded payer; a private-pool-funded hire is not yet run on devnet. One finalized receipt may fund one job and one earnings event. Refunds are separate seller-funded, finalized transfers to an owner-verified destination, cumulatively capped at the settled amount; failed delivery must remain visibly paid. Refund rules pass the live RLS e2e script; no live refund transfer is recorded. See the [marketplace guide](./marketplace.md).

## Devnet swap

An owner-approved swap is a private purchase whose second leg is an Orca swap instead of an x402 payment. It exists only on Solana devnet and has **not yet run** end to end on devnet; it is unit-tested in control, wallet, relayer and runner against fakes.

1. **Approval.** The owner approves one service, `swap:orca-devnet-sol-usdc` with SKU `swap-usdc-to-sol`, whose price is a **maximum per swap** (at most 5,000,000 base units). The pool (whirlpool `5GPCnpWwoDayCP5FVCJT1cS7dePufC5FrjPTVvPoUYnm`), direction (USDC to wrapped SOL), slippage (100 bps) and destination (`OWNER_RECOVERY_ADDRESS`) are fixed in code.
2. **Authorization.** The agent's input is exactly `{"amountUsdc": "<base units>"}`; any other field is refused. Control checks that the input matches the request digest and does not exceed the approved maximum, then prices the purchase at the requested amount, so the usual atomic reservation applies every cap to it. A swap is funded only through `private_x402`.
3. **Private funding.** The pool withdrawal funds a fresh wallet exactly as for an x402 purchase; the stored funding binding names the whirlpool and swap terms.
4. **Authority before signing.** Control records `sign_merchant` (rechecking policy and revocation) and asks the wallet to sign (`POST /fundings/:id/swap`).
5. **Wallet checks.** The wallet requires control's funding `finalized` and merchant `signed`. It reads the fresh wallet's USDC balance and swaps the **whole balance**, because anyone can send tokens to the public account and the same transaction must close it empty. It quotes on Orca, decodes the quoted `swapV2` and refuses it unless it sells exactly that balance of the fresh wallet's own USDC on the pinned whirlpool for the quoted minimum. It records `swap.signature_produced` before signing, so a crash never leads to a second signature.
6. **Relayer co-signing (`POST /swaps`).** The relayer accepts exactly five instructions: compute-unit limit; the sponsor creating the fresh wallet's wrapped-SOL account; one Orca `swapV2` on the pinned whirlpool; closing the wrapped-SOL account to the stated destination; closing the emptied USDC account with its rent to the sponsor. It verifies the fresh-wallet signature, checks the sponsor cap counting in-flight swaps at their worst case, and rechecks both the swap id and the cap inside the transaction that records it, so a concurrent retry neither re-broadcasts nor counts twice. Its crank marks a swap finalized only once it can read the fee from the finalized transaction.
7. **Settlement.** A finalized swap records the merchant leg finalized at the requested amount and the fulfilment delivered, with the minimum and estimated SOL output and the signature. A failed or expired swap moves the merchant leg to `expired_unsettled` and fulfilment to `abandoned`, and marks the purchase recoverable; the USDC stays in the fresh wallet. A wallet refusal (`recovery_required`) keeps the merchant leg `signed`, because the refusal alone does not prove whether a signature exists.

**Recovery of a swap that was never signed.** If the wallet holds no stored swap and no `swap.signature_produced` record for the purchase, owner recovery calls control's `POST /internal/wallet/purchases/:id/swap-not-signed` under the same lock that signs swaps. Control moves the merchant leg from `signed` to `expired_unsettled` with reason `swap_never_signed` and abandons fulfilment, and the wallet refuses to sign afterwards. The funded USDC is then recovered to `OWNER_RECOVERY_ADDRESS` like any funded wallet.

**Withdrawing approval** refuses new swaps at authorization and cancels a reserved swap whose proof was not released. A swap already released keeps settling or becomes recoverable.

**Privacy.** The swap is paid by a fresh wallet funded from the pool, but the SOL lands publicly at the owner's configured address, which links that swap to the owner.

**Known gaps (in code, not fixed):**

- The relayer does not reserve sponsor capacity for the later swap when it accepts the funding withdrawal, so a swap can be refused `BUDGET_EXCEEDED` after its funding settled; the USDC then stays recoverable in the fresh wallet.
- A failed swap's sponsor fee is recorded by the relayer but not passed to control's purchase record.
- In `services/relayer/src/withdrawals.ts`, a withdrawal fee is not recorded, and a recovery fee is recorded as 0, when `getTransaction` returns nothing.

## Recovery and failure handling

| Boundary | Required handling |
|---|---|
| Proof released, withdrawal outcome unknown | Keep exposure reserved; reconcile nullifier/chain state and proof expiry |
| Withdrawal finalized, merchant not signed | Track the funded wallet separately from pool notes; resume only within current policy |
| Merchant signed/submitted, response lost | Query the existing signature; do not automatically create another payment |
| Settlement finalized, issuance interrupted | Reconcile and issue the same pack once |
| Provider request outcome unknown | Record uncertain or paid-without-result; no blind retry without upstream idempotency |
| Agent stopped with a funded wallet | Recover only to the configured owner destination after conflicting authority is resolved |
| Swap leg never signed | Owner recovery records `swap_never_signed` in control, then recovers the funded USDC |
| Swap failed or expired on chain | Merchant leg `expired_unsettled`; USDC stays in the fresh wallet, recoverable by the owner |

Quote expiry, transaction last-valid block height and proof `valid_until_slot` are different bounds. Expiring a transaction does not necessarily invalidate a released proof that can be placed in another transaction. Release its reservation only after finalized chain evidence proves the authorization is no longer usable and no spend settled.

A public exit requires note ownership proof and the original refund authority. It must remain possible without approved-set membership; it reveals information and does not restore privacy. Test both original and change notes.
