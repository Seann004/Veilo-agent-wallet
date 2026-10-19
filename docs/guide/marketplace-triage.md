# Marketplace verification

The marketplace is implemented in the application. This page separates recorded checks from end-to-end release evidence; see [current status](./status.md) for the overall product.

| Area | Recorded coverage | Remaining verification |
|---|---|---|
| Identity and private data | Supabase isolation checks across anonymous users, buyers, sellers, controllers and seller hosts | Explicit wallet-switch ownership test |
| Quotes and recipients | Unit checks reject altered terms; database checks protect recipients and state transitions | Fresh private-funded devnet hire |
| Limits and duplicate receipts | Unit concurrency checks; one settlement signature cannot fund two jobs | Concurrent live hire rehearsal |
| Settlement and earnings | Completed devnet seller hires with zero platform fee | Those recorded payers used public funding |
| Retry and failure handling | Unit checks reconcile lost replies and keep paid failures visible | Live crash/restart drill |
| Refunds and leases | Database checks cap refunds and reject stale/wrong leases | Live refund transfer and offline-controller drill |
| Files and connectors | Quarantined artifacts, signed downloads, reviewed read-only tools | Hostile-file exercise, seller-host MCP execution and retention cleanup |
| Workflows | Workflow runner, approved tools and per-step accounting in code | Recorded private-funded multi-step devnet workflow |

The Supabase suite recorded 84 passing checks with fixture chain reads. It does not establish a hosted execution sandbox or successful live settlement for every workflow. A free-job path, credential broker and automated retention cleanup are not implemented.

External tools require configured seller hosts, provider credits and working accounts. Configuration alone is not execution evidence. [Execution evidence](../evidence.md) lists the public receipts available for submission.
