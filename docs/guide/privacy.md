# Privacy and trust

For recorded verification and remaining checks, see [current status](./status.md).

## Intended protection

A shared note-based pool aims to remove the **explicit mapping from a particular deposited note to a withdrawal**. A local proof authorizes the withdrawal without naming the spent deposit. A fresh wallet then pays the merchant through standard x402, and private change remains in the pool.

This requires real on-chain proof verification and authenticated tree updates. Cosmetic address rotation, a trusted database withdrawal authorizer or an ordinary direct x402 payment does not establish this property.

## Which agent or wallet can someone identify?

| Question | Intended behavior |
|---|---|
| Can a public observer see the wallet that pays the merchant? | Yes. The fresh payment address, merchant, amount and timing remain public. |
| Does the withdrawal explicitly identify its original deposited note? | No, in a correctly implemented proof-based flow. Removing this explicit link is the privacy target. |
| Is an agent name or stable workspace ID published with each payment? | It must not be included in chain memos, proof public fields or withdrawal accounts. |
| Can the owner tell which agent spent money? | Yes. The local workspace keeps purchase attribution and outcomes. |
| Can the gateway link purchases or usage? | Yes. Its authenticated workspace account and request data provide off-chain linkage. |
| Is correlation impossible? | No. Small pools, distinctive amounts, funding trails, timing and network metadata can weaken privacy. |

Funding privacy and owner monitoring serve different audiences: the owner retains accountability while the chain omits an explicit deposit-to-withdrawal mapping. This is not a promise that every payment is anonymous to every observer.

## Visibility matrix

| Observer | Information visible in the intended design |
|---|---|
| Public-chain observer | Deposits, source addresses, payout wallets, amounts, mint, merchant payments, fees, timing, public exits and proof public inputs |
| Owner / local wallet service | Note secrets, local agent/task attribution, spending history, recovery metadata and signer material |
| Gateway operator | Authenticated workspace credit account, purchases, requests/prompts, usage, cached results and connection metadata |
| OpenRouter | Operator account, forwarded prompts and model/request metadata; internal workspace IDs are not forwarded by default |
| Relayer / RPC | Submitted public transactions and relevant connection/timing metadata; relayer should not receive note secrets |
| Approved-set / upgrade administrators | Disclosed powers to update approved membership or deployed program code, according to configuration |

Persistent gateway accounts deliberately link service usage off chain. The protocol does not hide prompts from the provider or establish network-level anonymity.

## Agent tools added after the merge

| Path | Who else sees what |
|---|---|
| Owner's model provider | Prompts, gathered page and connector text, outputs and any reference image. The provider bills and identifies the owner. |
| Read-only browsing | Each site sees a request from the runner host's address; control's audit keeps only the host. |
| Connectors (including CoinGecko market data) | The connector server sees the call arguments, such as coin ids. Calls are keyless and not private. |
| Result destinations | Telegram, Slack or Discord receive the task's saved outputs as plain text. |
| Devnet swap | A fresh wallet funded from the pool pays the swap, but the SOL lands publicly at `OWNER_RECOVERY_ADDRESS`, linking that swap to the owner's address. |

## Marketplace observer boundary — accepted v3.2 scope

Marketplace identity and job records create additional off-chain linkage. The marketplace operator, sellers, facilitators and model providers can see the buyer–seller relationship and plaintext job content they process. Supabase Web3 identity does not hide a buyer from the cloud operator. Private Storage and RLS restrict application access; they do not establish transaction or metadata anonymity.

Hosted seller execution must receive only permitted job data and no wallet secrets. Participant files are private and downloaded through short-lived signed links (checked in the live RLS e2e script). The required 30-day retention cleanup is not implemented. See [marketplace](./marketplace.md) and [acceptance gaps](./marketplace-triage.md).

## Correlation and anonymity limits

A small pool, one active participant, distinctive amounts, closely timed deposit/withdrawal/payment and common operator funding can make linkage plausible. Synthetic demo participants are not independent users. Approved-set size is membership information, not a measured anonymity score.

A separate fee sponsor reduces one obvious source link, but shared RPC endpoints and sponsor funding trails still permit correlation. Public exits and recovery transactions may reveal aggregate spending through subtraction.

Funding privacy does not guarantee anonymity against every observer. Security depends on correct circuits, proof verification, key handling and operational controls.

## Cryptography and setup trust

The current setup uses a deterministic local development powers-of-tau with public beacons. Its toxic waste is derivable: it is unsuitable for production funds. The development setup and unaudited verifier remain material trust risks even though M2 transactions finalized. See [known risks](../security/risks.md).

The Solana proof design uses BN254 Groth16, matching Poseidon parameters and canonical encodings across TypeScript, Circom and Rust.

The deployment manifest must pin circuit/compiler source, curve, hash parameters, public-input order, encoding/vector version, tree depths, proving/verifying-key hashes and setup provenance. Artifact mismatch stops proof generation. A malicious setup, buggy circuit/verifier or excessive upgrade authority can compromise funds/privacy.

Spend and public exit share one pool-scoped nullifier namespace. Bind withdrawal intent to the deployed program/pool, network, mint, exact destination, value/fees and on-chain expiry. The on-chain program reconstructs the intent; an off-chain annotation is insufficient.

## Operational privacy

- Keep note secrets and decryption/signer keys in the local wallet service, inaccessible to the runner.
- Do not put agent names, workspace IDs or gateway account identifiers in chain memos, withdrawal accounts or proof public fields.
- Minimize operator logs; redact secrets, authorization headers and private prompt content before evidence export.
- Retain enough authenticated purchase/result state to reconcile ambiguous outcomes; disclose retention and clean up only after outstanding operations resolve.
- Back up notes, change secrets, paths/rebuild data, fresh-wallet counters and pending operations with an encrypted snapshot. Wallet and control files are copied separately; quiesce writers for an operator snapshot and retain matching gateway state.

The owner machine remains trusted. Local proof generation does not protect secrets from a compromised host.

## Evidence needed before a privacy claim

Demonstrate a real deployed verifier, valid spend/change and owner exit, rejection of invalid proof/context/replay, public-input inspection for stable identifiers, and multiple clearly labeled test deposits. Include the metadata caveats above alongside that evidence. See [security matrix](../security/evidence.md) and [known risks](../security/risks.md).
