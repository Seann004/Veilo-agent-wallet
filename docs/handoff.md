# Handoff and submission gaps

Documentation prepared against source snapshot `fe13778` on 17 October 2026. [Current status](./guide/status.md), [demo checklist](./guide/demo.md) and [security evidence](./security/evidence.md) are the public record. T16 materials are prepared; final fresh-operator/live-inference acceptance remains open while T15's devnet demo is **not yet run**.

## Pending operator evidence

Run `pnpm demo:run -- --execute --confirm` after readiness/configuration, then `pnpm evidence:export`. Fill the demo checklist's deposit/approval, Shawn, Prince, Mira and exit hashes; attach live inference receipts, research brief, drafts/calendar, duplicate/rejection outcomes and funded dashboard screenshots. Record unattended scheduler execution separately if claiming autonomous top-up: the script explicitly invokes “Check now.” A funded-wallet recovery scenario is separate from the script's public exit.

Attach tested source commit, UTC time, reviewer, lockfile/artifact hashes and every failure/skip. Existing integration JSON records program hash and environment, not the tested Git commit. Existing M2 is a separate synthetic-participant pool/Echo run and cannot fill agent gateway placeholders.

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

## Owner decisions

- Select Veilo's project license, review GPL component distribution and resolve the verifier license discrepancy. `NOTICE` preserves attribution and assigns no project license.
- Confirm organizer acceptance of Solana devnet, reference reuse and screenshot/presentation limits. A short presentation/video and final organizer sign-off are not supplied by this documentation pass.
- Choose which internal submission deliberations, private prompts, research objectives and screenshots may be public. Tracked `internal/` files are readable in a public repository; their name offers no confidentiality. The four draft Markdown files now point to canonical public documents; the stale all-not-run CSV was removed and the JSON record remains an explicitly unfilled template.
- Approve concrete sanitized submission outputs after the operator run. Automated scanning does not determine whether prompts, task objectives or screenshots contain confidential content. Keep raw logs, notes/witnesses, credentials, key files, encryption roots and encrypted backups owner-local.
