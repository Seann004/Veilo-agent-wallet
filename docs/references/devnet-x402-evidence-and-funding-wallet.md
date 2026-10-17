# Part IV — Verified devnet x402 payment evidence

# Verified devnet USDC x402 demo route

Date: October 14, 2026. Scope: actual ordinary x402 V2 payment and refund, not a private-pool or inference test.

## Result

Paid 0.01 devnet USDC (10,000 base units) from Veilo's funded setup wallet to PayAI's Echo Merchant. Received HTTP 200 and the protected resource. Independently fetched both payment and refund transactions through Solana devnet RPC: finalized, no on-chain errors, matching transferChecked mint and amount in both directions. Merchant refunded the full 0.01 USDC.

- Wallet: 3FCio7smQJX7fm5x4Rz2UPPesfHA46FkexC3S3SqkMFd.
- Merchant: 8sqyMHQwBh8BCXC99pdgt6BpXwLu9xqfL1hDV5SFYf3R.
- Mint: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU (six decimals).
- Network: solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1.
- Scheme: exact, x402Version 2.
- Protected URL: https://x402.payai.network/api/solana-devnet/paid-content.
- Facilitator: https://facilitator.payai.network.
- [Finalized payment](https://explorer.solana.com/tx/5Br4iPZQWqnc4WxxFDSbnTxkNaDYgcxax3T8VHo6FF8YzryiEZ9zXMEvSzWVmM4zScGjCSa37qKtYHY2BtQDuNvB?cluster=devnet), slot 510976967.
- [Finalized refund](https://explorer.solana.com/tx/W8WnBPng78B8FXswy3TfRryEBwTykqihB1SuDzGCsya95XFooST3nJVYuadGvKEQbMxXGz1TeyaTeeqwts6B9EU?cluster=devnet), slot 510976975.

Client authorized one payment only, with an exact recipient/network/mint allowlist and 0.01 USDC ceiling. No mainnet funds or provider credentials were used. This test used the setup wallet directly and provides no payer privacy; it verifies the standard merchant leg needed after a future private withdrawal.

## Recommended Veilo content flow

Mira requests a bounded content-generation job from our gateway. Gateway returns an immutable x402 devnet requirement. Owner-controlled wallet checks policy, obtains real proof-funded fresh-wallet USDC from the deployed privacy pool, and signs a standard SVM exact merchant payment. PayAI verifies/settles that merchant leg. Gateway checks finality and idempotency, invokes its separately funded OpenRouter account, and returns drafts/calendar. The pool relayer and PayAI facilitator perform different jobs; PayAI does not verify Veilo's ZK withdrawal.

The Echo Merchant is a live payment smoke test, not an LLM provider. The custom gateway and OpenRouter adapter still need implementation and an operator credential. Real privacy still requires the pool program and circuit artifacts; neither is deployed by this test.

## Alternatives and fallback

Live capability reads also found x402 V2 exact Solana devnet support at https://facilitator.x402.rs/supported, but no settlement was tested there. A request to https://x402.org/facilitator/supported returned HTTP 403 in this environment; do not make it the demo dependency without a new check.

Self-hosted fallback: Solana Foundation Kora's documented x402 V2 devnet demo. Use its supported/configuration checks and own fee sponsor if managed PayAI availability or terms become unsuitable. Do not switch to mainnet automatically on managed-provider failure.

## Tested package versions

- @x402/core: 2.28.0
- @x402/fetch: 2.28.0
- @x402/svm: 2.28.0
- @solana/kit: 5.5.1

## Primary references

- [PayAI Echo Merchant](https://x402.payai.network/).
- [PayAI developer portal](https://payai.network/developers).
- [Solana x402 V2](https://solana.com/docs/payments/agentic-payments/x402).
- [Kora devnet facilitator guide](https://solana.com/docs/tools/kora/guides/x402).

Advertised capabilities and fee policies can change; startup rechecks /supported and enforces independent limits. This one successful payment demonstrates availability at test time, not a production SLA.


---

# Part V — Public funding-wallet setup

```text
Veilo development funding wallet
Network: Solana devnet only
Public address: 3FCio7smQJX7fm5x4Rz2UPPesfHA46FkexC3S3SqkMFd
Use this owner address for devnet SOL and USDC faucets.
This is a local setup wallet, not a deployed pool address.
Do not send mainnet assets.
Private key remains locally in work/keys/veilo-devnet-funding.json (restricted permissions); do not upload or commit it.
```

These addresses and balances are public test-network facts, not instructions to send mainnet assets. The keypair is not included. Historical balances must be rechecked before deployment. The privacy pool address will be derived after real deployment and is not this setup wallet.
