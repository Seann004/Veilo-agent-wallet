# Handoff and submission gaps

Updated after PR #3 merged the parallel worktrees into `main` (`59696dd`) and rechecked against `59eb491` (PR #5). [Current status](./guide/status.md), [demo checklist](./guide/demo.md) and [security evidence](./security/evidence.md) are the public record. One complete devnet demo run with live inference is recorded from before the merge; the marketplace is implemented with devnet acceptance incomplete; see [marketplace triage](./guide/marketplace-triage.md).

## Pending operator evidence

Run `2026-10-17-1eba868c` filled the deposit/approval, Shawn, Prince, Mira, duplicate, over-budget/revoke and exit records (see the demo checklist). Still outstanding:

- A fresh post-merge devnet run, so the submitted tree and the recorded run match.
- The dashboard on devnet with browser-wallet (Phantom) signing, and screenshots 01–08 from that run.
- An unattended scheduler top-up, if submission claims autonomous execution; the script invokes Shawn's check explicitly.
- A funded-wallet recovery scenario, separate from the script's public exit.
- Marketplace: a private-pool-funded hire, a multi-step workflow run, a paid QuickNode x402 call and an MCP tool run through a seller host, all on devnet.
- A first owner-approved devnet swap end to end (none recorded), and seeding `coingecko-market` into the live marketplace with `pnpm marketplace:seed --confirm`.
- A clean full `pnpm test` run on `59eb491`: the recorded run had 9 timeouts during a host pause, which passed when their files were rerun alone.

Attach tested source commit, UTC time, reviewer, lockfile/artifact hashes and every failure/skip. The integration JSON and the evidence export do not record the tested source commit. M2 is a separate synthetic-participant pool/Echo run and cannot fill agent gateway placeholders.

## Merged branches

PR #3 (`chore/integrate-worktrees`) brought the parallel work into `main`: the devnet demo-run fixes and native redeployment (program `27Dg…AjFd`, recorded runs), the dashboard polish and redesign (landing page, `/workspace`, rule-based limit drafting, guest and public view, dark mode, Connectors page), the marketplace branches (seller host, control bridge, marketplace UI, open workflows, read-only MCP connectors) and the submission materials. Their evidence now lives in this tree; earlier notes that described these branches as unmerged no longer apply.

## Known documentation inconsistencies

Observed at the earlier baseline and not yet rechecked line by line after the merge:

- `docs/build-status.md`: T04's early “no signature” blocker precedes an appended successful operator payment. T08 still says no devnet run, while T09's M2 evidence exists. T09 retains “nothing signed,” “remaining operator commands” and “uncommitted fix” history beside its completed run. T11's old root typecheck failure conflicts with T15's later clean check. The T16 row is still not-started and should be updated by its owner after this handoff, without marking the unmet live gate passed. Environment notes describe the historical Windows verification host, not every checkout.
- `docs/deployment.md`: initial program-ID/keypair notes mix placeholder/build identities and say the deployment identity is created by `deploy:devnet`, though `keys:init` creates it. Fresh operators cannot assume “already run” keys, `.env` or funding-wallet files exist. Historical deployment budget/default-rent measurements and expected “not deployed” dry-run output must be read alongside the later live M2 record, not as current chain state.
- `docs/deployment.md` / setup: `setup:local` creates an encryption root only when its path is configured, and does not generate service credentials. The [running guide](./guide/running.md) supplies a fresh manual-stack procedure. The isolated demo creates its own credentials and uses different ports/databases.
- `docs/deployment.md` / backups: each SQLite file is backed up separately; the backup implementation does not establish a simultaneous transaction across control and wallet databases or include the gateway ledger. Quiesce writers for an operator snapshot, retain matching gateway state/credentials and reconcile; do not describe it as a complete multi-service restore without that evidence.

## Issues in scripts and dependencies outside this documentation scope

- `scripts/evidence-export.ts` collects signatures from local `integration-*.json` and assigns devnet explorer links to all of them. Source-file environment labels are authoritative; the aggregate signature index is not a devnet register. It also lacks a source Git commit field.
- `scripts/demo-run.ts` drives backend services and stops them on completion. It launches no dashboard and does not verify browser-wallet signing. Its manual Shawn trigger does not alone prove unattended scheduling. It demonstrates public exit, not funded-wallet recovery.
- `groth16-solana` 0.2.0 metadata says MIT, but the published crate's license file is Apache-2.0. Build status T06 calls it MIT without mentioning this discrepancy. Resolve with upstream before a release; see [license map](./references/attribution.md).

## Marketplace delivery triage

The [marketplace guide](./guide/marketplace.md) covers the buyer/seller experience and cloud/local/payment boundaries. [Implementation triage](./guide/marketplace-triage.md) maps T17–T23 and all fourteen §26.6 checks to the live RLS e2e script, unit tests and devnet smokes. Remaining blockers: no free job path, no credential broker or hosted sandbox, no content-retention cleanup, no live refund transfer or offline-controller drill, and no private-pool-funded hire on devnet. Higgsfield, MakeUGC and Zernio are unverified and shown as "Provider not configured" by owner decision.

## Known code gaps found while documenting `59eb491`

- The relayer does not reserve sponsor capacity for a swap when it accepts the swap's funding withdrawal.
- A failed swap's sponsor fee is recorded by the relayer but not passed to control's purchase record.
- `services/relayer/src/withdrawals.ts` skips a withdrawal's sponsor fee, and records a recovery's as 0, when `getTransaction` returns nothing.

These are described in [payments](./guide/payments.md#devnet-swap); no code was changed by the documentation pass.

## Owner decisions

- Marketplace inclusion and Supabase adoption are settled in v3.2, and the Supabase project is configured with all 19 migrations applied. The hosted-isolation approach is still open; do not downgrade accepted scope.
- Select Veilo's project license, review GPL component distribution and resolve the verifier license discrepancy. `NOTICE` preserves attribution and assigns no project license.
- Confirm organizer acceptance of Solana devnet, reference reuse and screenshot/presentation limits. A short presentation/video and final organizer sign-off are not supplied by this documentation pass.
- Choose which internal submission deliberations, private prompts, research objectives and screenshots may be public. Tracked `internal/` files are readable in a public repository; their name offers no confidentiality. The four draft Markdown files now point to canonical public documents; the stale all-not-run CSV was removed and the JSON record remains an explicitly unfilled template.
- Approve concrete sanitized submission outputs after the operator run. Automated scanning does not determine whether prompts, task objectives or screenshots contain confidential content. Keep raw logs, notes/witnesses, credentials, key files, encryption roots and encrypted backups owner-local.
