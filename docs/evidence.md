# Execution evidence and submission

Public receipts and files for the Autonomous On-chain Wallet submission. All transaction links below use **Solana devnet**.

## On-chain transactions

Recorded 17 October 2026; checked on 19 October as finalized with no on-chain error. This page does not perform continuous finality checks.

| Operation | Amount | Receipt |
|---|---:|---|
| Pool withdrawal | 0.01 devnet USDC | [View on Explorer](https://explorer.solana.com/tx/2fbWQ6ws2y2sHFUgBeELnKVsdVKZwpBnx6ma9kkwhkHtdw9ki2fBq14UN3nqdFMBcGsLQKUVK36aE1w7DBcPJLE3?cluster=devnet) |
| x402 merchant payment | 0.01 devnet USDC | [View on Explorer](https://explorer.solana.com/tx/3mChKemwTiirm9TvVpFMzbKiMQAkDB8SMX74nWgkmjhzijY2TRszZQpkET6PU6EQD5p6oEQt7jds2JmwSWLJWReA?cluster=devnet) |
| Owner withdrawal | 0.20 devnet USDC | [View on Explorer](https://explorer.solana.com/tx/52EVL9oes4qKYArNqEFySbC7g5pNwEVxAo9bMZ7JXNNRqoVC6yeeBoPGarvequ2sDT78Xb2YRarN5t8XLmT8BEZu?cluster=devnet) |

[Download full transaction hashes and provenance](./evidence/transactions.json)

The first two receipts show a proof-authorized pool payout followed by an x402 payment from that fresh wallet to PayAI Echo. Echo is a test merchant and refunds payments. The owner withdrawal uses a separate eligible note. Operator commands supplied the control stages; these receipts do not prove unattended initiation.

## Additional verification

| Record | Result | Scope |
|---|---|---|
| [Agent workflow report](./evidence/agent-workflow.json) | 11 acceptance checks passed | Historical devnet run with three private x402 purchases and live inference; backend-driven with synthetic research inputs |
| Local integration | 30 cases passed | Local validator and mock inference; not public devnet transaction evidence |
| Automated review | 994 passed, 1 skipped | Recorded on 19 October against `b155f17`; see [review details](./submission-review-2026-10-19.md) |
| Marketplace isolation | 84 checks passed | Live Supabase checks with fixture chain reads; see [marketplace verification](./guide/marketplace-triage.md) |

These records have different environments and dates. Fresh current-path swap and private-funded marketplace workflow evidence remain listed in [current status](./guide/status.md).

## Submission checklist

| Required item | Submission resource |
|---|---|
| Technical documentation | [Architecture](./guide/architecture.md), [protocol](./protocol.md), [deployment](./deployment.md) |
| Presentation, at most 10 minutes | <a :href="withBase('/submission/Veilo.pptx')" download>Download PowerPoint</a>, including spoken presenter notes |
| Demo video, optional and at most 5 minutes | Final video link pending recording/upload |
| Source code, README and test cases | [Repository](https://github.com/Seann004/Veilo-agent-wallet), [running guide](./guide/running.md), [verification requirements](./security/evidence.md) |
| Security self-assessment | [Permission tiers and enforcement](./security/assessment.md), [known risks](./security/risks.md) |
| On-chain execution evidence | Explorer links and downloadable transaction record above |

Repository access is currently restricted; arrange reviewer access for source inspection. The receipts, workflow report and PowerPoint downloads on this page are public. No local keys, credentials or note secrets are included.

<script setup>
import { withBase } from 'vitepress'
</script>
