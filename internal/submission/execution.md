# Execution evidence

## Current evidence boundary

Integrated Veilo execution evidence is pending. An earlier ordinary x402 payment/refund report, dated 14 October 2026, records the devnet transactions below. Their reported finality has **not been independently rechecked through RPC for this evidence register**.

| Historical leg | Signature / explorer | What it can support if reverified |
|---|---|---|
| Echo payment | [Devnet payment](https://explorer.solana.com/tx/5Br4iPZQWqnc4WxxFDSbnTxkNaDYgcxax3T8VHo6FF8YzryiEZ9zXMEvSzWVmM4zScGjCSa37qKtYHY2BtQDuNvB?cluster=devnet) | Ordinary x402 transfer of 10,000 base units (0.01 test USDC), reported in the earlier integration test |
| Echo refund | [Devnet refund](https://explorer.solana.com/tx/W8WnBPng78B8FXswy3TfRryEBwTykqihB1SuDzGCsya95XFooST3nJVYuadGvKEQbMxXGz1TeyaTeeqwts6B9EU?cluster=devnet) | Reported full refund of that ordinary transfer |

This used the setup wallet directly. It proves neither Veilo privacy, a real ZK withdrawal, inference delivery, nor full idempotency. The reference project's Cardano evidence is also not Veilo Solana evidence.

## Integrated evidence register

| Evidence ID | Required artifact | Current status |
|---|---|---|
| DEP-01 | App commit, lockfile hashes, complete deployment/proof manifest and authority public keys | Not supplied |
| FLOW-01 | Owner deposit and finalized authenticated insertion, with network/mint | Not supplied |
| FLOW-02 | Real proof withdrawal and fresh wallet funding; private change insertion | Not supplied |
| FLOW-03 | Standard x402 merchant signature bound to same redacted operation | Not supplied |
| FLOW-04 | One credit issuance after Shawn top-up, duplicate trigger and restart result | Not supplied |
| FLOW-05 | Prince purchased evidence and bounded inference consumption, attributable brief | Not supplied |
| FLOW-06 | Mira direct private x402 content purchase, real result, three drafts and seven-day calendar | Not supplied |
| FLOW-07 | Duplicate payment prevention, concurrent cap rejection and revoke race | Not supplied |
| FLOW-08 | Original/change owner exit and safe funded-wallet recovery | Not supplied |
| FLOW-09 | Consistent encrypted backup restore with pending operation reconciliation | Not supplied |

## Evidence record format

Use one redacted record per case or flow. Copyable template: [evidence-record.json](/evidence-record.json).

Record test ID; exact tested commit/environment; UTC time; reviewer; scenario/command; expected and observed outcome; status (not-run/pass/fail/blocked); program/mint and transaction signatures where relevant; artifact paths/links; failures/skips; and known-risk references. Link every record to the [security matrix](./security-evidence.md).

An explorer link alone proves a public transaction, not a private witness, off-chain policy enforcement, correct service delivery or absence of a second charge. Combine it with manifest, real verifier tests and redacted durable operation events.

## Publish safely

Never publish private notes/witnesses, seed phrases, wallet key files, encrypted-secret backups, decryption keys, provider tokens, auth/session headers or sensitive prompt content. Inspect logs/screenshots individually. Public keys and transaction signatures may be published deliberately, with the accompanying correlation/privacy implications explained.

Preserve raw sensitive diagnostic material locally only under the owner-approved handling process. Publish the minimum redacted evidence needed to reproduce the conclusion with independently supplied test credentials.
