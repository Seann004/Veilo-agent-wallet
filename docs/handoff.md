# Handoff and submission gaps

Documentation updated for PRD v3.2 on 17 October 2026; implementation baseline `8bfe4a2` / `fe13778` and separately identified parallel branches. [Current status](./guide/status.md), [demo checklist](./guide/demo.md) and [security evidence](./security/evidence.md) are the public record. T16 materials are prepared; full live-inference acceptance still lacks the complete record here. The marketplace is accepted scope with T17–T23 pending; see [marketplace triage](./guide/marketplace-triage.md).

## Pending operator evidence

Recover the earlier run’s state/ledgers/evidence described below before deciding another paid run is needed. Use the acceptance-checking script version from the deployment branch to review that run; if a new run is necessary, execute after readiness/configuration and export its evidence. Fill the demo checklist's deposit/approval, Shawn, Prince, Mira and exit hashes; attach live inference receipts, research brief, drafts/calendar, duplicate/rejection outcomes and funded dashboard screenshots. Record unattended scheduler execution separately if claiming autonomous top-up: the script explicitly invokes “Check now.” A funded-wallet recovery scenario is separate from the script's public exit.

Attach tested source commit, UTC time, reviewer, lockfile/artifact hashes and every failure/skip. Existing integration JSON records program hash and environment, not the tested Git commit. Existing M2 is a separate synthetic-participant pool/Echo run and cannot fill agent gateway placeholders.

## Parallel-branch evidence

Read-only inspection on 17 October 2026 found:

- `fix/devnet-demo-run` at `96dac1d`: its deployment record reports a 17 October 01:15–01:18 UTC devnet execution with three deposits, private withdrawals, gateway merchant payments and a public exit. Run state, gateway ledger and full task/live-inference evidence are not committed there. This corrects “never executed,” but does not establish completed agent acceptance. Recover original files before paying again. No new transaction signatures were copied into these docs.
- That branch also contains `356a1ce`, which tightens `demo:run` acceptance for completed tasks, merchant legs and live inference. The docs checkout’s older script is not that version; a successful exit from an older script is not sufficient evidence. Its macOS report identifies missing Docker, compatible proving files, funded role keys and provider configuration as blockers.
- `feat/dashboard-polish` at `8670434` includes natural-language limit drafting and new local-stack screenshots. Those changes/screenshots are not merged here and do not demonstrate funded browser-wallet acceptance. “Not implemented here” statements describe this checkout, not a claim that no parallel work exists.
- The main `feat/marketplace` working tree contains the v3.2 amendment, an inventory and a draft marketplace limits module. The PRD was synchronized here; the working implementation files were not imported. Discovery/schema freeze and all marketplace acceptance remain unproven here.

These branches were inspected without modification. Their owners still control their code, build status and deployment runbook. The legacy issues below describe this checkout’s baseline and must be rechecked against the version selected for integration.

## Issues in files owned by the deployment/build agent

These were observed but deliberately not edited:

- `docs/build-status.md`: T04's early “no signature” blocker precedes an appended successful operator payment. T08 still says no devnet run, while T09's M2 evidence exists. T09 retains “nothing signed,” “remaining operator commands” and “uncommitted fix” history beside its completed run. T11's old root typecheck failure conflicts with T15's later clean check. The T16 row is still not-started and should be updated by its owner after this handoff, without marking the unmet live gate passed. Environment notes describe the historical Windows verification host, not every checkout.
- `docs/deployment.md`: initial program-ID/keypair notes mix placeholder/build identities and say the deployment identity is created by `deploy:devnet`, though `keys:init` creates it. Fresh operators cannot assume “already run” keys, `.env` or funding-wallet files exist. Historical deployment budget/default-rent measurements and expected “not deployed” dry-run output must be read alongside the later live M2 record, not as current chain state.
- `docs/deployment.md` / setup: `setup:local` creates an encryption root only when its path is configured, and does not generate service credentials. The [running guide](./guide/running.md) supplies a fresh manual-stack procedure. The isolated demo creates its own credentials and uses different ports/databases.
- `docs/deployment.md` / backups: each SQLite file is backed up separately; the backup implementation does not establish a simultaneous transaction across control and wallet databases or include the gateway ledger. Quiesce writers for an operator snapshot, retain matching gateway state/credentials and reconcile; do not describe it as a complete multi-service restore without that evidence.

## Issues in scripts and dependencies outside this documentation scope

- `scripts/evidence-export.ts` collects signatures from local `integration-*.json` and assigns devnet explorer links to all of them. Source-file environment labels are authoritative; the aggregate signature index is not a devnet register. It also lacks a source Git commit field.
- `scripts/demo-run.ts` drives backend services and stops them on completion. It launches no dashboard and does not verify browser-wallet signing. Its manual Shawn trigger does not alone prove unattended scheduling. It demonstrates public exit, not funded-wallet recovery.
- `groth16-solana` 0.2.0 metadata says MIT, but the published crate's license file is Apache-2.0. Build status T06 calls it MIT without mentioning this discrepancy. Resolve with upstream before a release; see [license map](./references/attribution.md).

## Marketplace delivery triage

The [marketplace guide](./guide/marketplace.md) covers the full accepted buyer/seller experience and cloud/local/payment boundaries. [Implementation triage](./guide/marketplace-triage.md) maps T17–T23 and all fourteen §26.6 acceptance checks to missing evidence. Immediate blockers are the unfrozen marketplace contracts, absent Supabase isolation/Storage, fixed runner roles/free execution, single-merchant managed gateway, missing receipt/job/earnings binding and absent hosted isolation/connector broker. No marketplace migration or pool change was made in this documentation pass.

## Owner decisions

- Marketplace inclusion and Supabase adoption are settled in v3.2. Select the project/deployment configuration, frozen contracts and hosted-isolation approach during implementation; do not downgrade accepted scope.
- Select Veilo's project license, review GPL component distribution and resolve the verifier license discrepancy. `NOTICE` preserves attribution and assigns no project license.
- Confirm organizer acceptance of Solana devnet, reference reuse and screenshot/presentation limits. A short presentation/video and final organizer sign-off are not supplied by this documentation pass.
- Choose which internal submission deliberations, private prompts, research objectives and screenshots may be public. Tracked `internal/` files are readable in a public repository; their name offers no confidentiality. The four draft Markdown files now point to canonical public documents; the stale all-not-run CSV was removed and the JSON record remains an explicitly unfilled template.
- Approve concrete sanitized submission outputs after the operator run. Automated scanning does not determine whether prompts, task objectives or screenshots contain confidential content. Keep raw logs, notes/witnesses, credentials, key files, encryption roots and encrypted backups owner-local.
