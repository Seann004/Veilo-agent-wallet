# Eight-step demo and evidence checklist

**Status:** complete integrated devnet acceptance evidence is missing here. The parallel deployment branch records an earlier gateway execution, but its run state, ledger, live inference receipts and task artifacts are absent here; recover/review them before paying again. Local rehearsal is **verified on local test validator** with a **fixture / mock provider**. M2 has its separate devnet proof/Echo record. Do not fill missing agent evidence with local signatures or Echo transactions.

This eight-step script covers the original T00–T16 workspace. The v3.2 marketplace has separate [T17–T23 gates and acceptance checks](./marketplace-triage.md); completing this script does not demonstrate seller hiring, Supabase isolation or marketplace earnings/refunds.

## Prepare once

Follow [running Veilo](./running.md) and [deployment](../deployment.md), including manifest-compatible proof files. Configure the funded demo owner (`FUNDING_KEY_PATH`), sponsor, approval authority, gateway merchant/ATA and devnet facilitator; configure the operator-funded provider and ceiling locally. No secret belongs in evidence.

```sh
pnpm demo:run
# When readiness passes, run all steps below in one resumable execution:
pnpm demo:run -- --execute --confirm
# After completion:
pnpm evidence:export
```

`demo:run` starts isolated backend services on ports 4701–4705, with dashboard Origin `http://localhost:4700`; it does not launch a dashboard. Run state is `work/demo/devnet-state.json`. Preserve it and rerun the same execute command after interruption; do not delete it to force a retry. The script activates seeded policies, changes Mira's limit, revokes Prince and exits change: review this plan before execution.

For UI recording, connect a dashboard to the same run's service ports, owner and Origin. The generated non-provider configuration is `work/demo/devnet/<runId>/demo.env`; launch the dashboard from the repository root with `VEILO_ENV_FILE=work/demo/devnet/<runId>/demo.env pnpm --filter @veilo/dashboard dev` (POSIX shell; set the environment variable separately in PowerShell). The backend processes stop when the script completes; later screenshots require restarting those same databases/credentials. Do not record an empty default workspace as if it were the funded run. Browser extension signing is still **not yet run**; the script signs with owner-local key files.

Evidence root: `artifacts/evidence/demo-<runId>/` (currently absent). In the steps below, names such as `steps.b-shawn-topup` identify JSON keys, not additional commands. Every **TODO** is intentionally unfilled until the operator run and evidence review.

## 1. Show network, pool, membership and policies

**Action:** read-only `pnpm demo:run`; during execution inspect `0-policies` and `a-deposits`. Show the dashboard network/privacy views and three policy cards if connected to this run. Three deposits in the integrated demo belong to one owner; M2's two participants were synthetic. Neither is a measured anonymity set.

**Expected evidence:** deployment/circuit manifests, `summary.json` network/program/pool, `steps.0-policies`, deposits and approvals; public amounts and small-set warning.

**TODO — demo deployment/approval/deposit transaction hashes:** pending recovered-run evidence or a newly accepted operator run. **TODO — screenshot 01:** network, pool limitations and three active policies.

## 2. Show Shawn below threshold and check now

**Action:** `b-shawn-topup` reads zero usable credits (<200,000), resumes Shawn and calls authenticated `POST /agents/:id/run`; the dashboard equivalent is Shawn's “Check now.” The scheduled and manual checks use the same deterministic logic.

**Expected evidence:** `summary.json` → `steps.b-shawn-topup.creditsBefore`, plus purchase/episode state and the post-check balance. The script records the manual invocation; do not call that alone proof of an unattended scheduled execution.

**TODO — screenshot 02:** low balance and the check/episode. **TODO — unattended scheduler evidence:** record a scheduler-triggered top-up separately if submission claims genuine autonomous execution.

## 3. Show proof funding, x402 and one issuance

**Action:** wait for `b-shawn-topup` to deliver the credit pack. Show the purchase's funding and merchant legs, fresh payer and exactly one 1,000,000-unit issuance. The merchant here must be the Veilo gateway; PayAI is the facilitator. M2 used Echo instead.

**Expected evidence:** `steps.b-shawn-topup.purchase`, `ledger.json` purchase `chainAttempts`/states and credits before/after; deployment/key hashes in the export.

**TODO — Shawn withdrawal and gateway settlement hashes:** pending recovered-run evidence or a newly accepted operator run. **TODO — screenshot 03:** purchase drawer and one issuance.

## 4. Run Prince research

**Action:** `c-prince-research` submits the task to the runner. Inspect the approved fixed-price research choice, prepaid `analyze` usage (or explicitly recorded permitted per-call fallback) and saved cited brief.

**Expected evidence:** task/purchases in `ledger.json`, `steps.c-prince-research`, `inference-receipts.json`, and `artifacts/research_brief-*.md`. Sources remain fictional CC0 demo fixture data even when inference is live. Provider receipts must say live/operator-funded; fixture output cannot meet this gate.

**TODO — Prince withdrawal/merchant hashes and live inference receipt:** pending recovered-run evidence or a newly accepted operator run. **TODO — screenshot 04:** approved service, categorized usage and attributable brief.

## 5. Approve handoff and run Mira

**Action:** `d-handoff-mira` approves `POST /handoffs/:id/decision` then starts Mira. Dashboard equivalents are handoff approval and the campaign form. Inspect the **direct private x402** `content-package` purchase, three editable drafts and seven-day calendar. No social publishing is authorized.

**Expected evidence:** `steps.d-handoff-mira`, direct payment in `ledger.json`, live receipt, `artifacts/content_draft-*.md` and `artifacts/content_calendar-*.json`. Distinguish direct USDC spend, credits consumed and sponsored planning costs.

**TODO — Mira withdrawal/merchant hashes and live inference receipt:** pending recovered-run evidence or a newly accepted operator run. **TODO — screenshot 05:** approved handoff, direct purchase, drafts and calendar.

## 6. Repeat a logical purchase

**Action:** `e-duplicate-check` repeats Prince's stable research intent and Shawn's check. Inspect the same purchase ID and zero new purchases; confirm neither settlement nor service execution duplicated. A skipped research repeat is a failed recording gate, not a pass.

**Expected evidence:** `steps.e-duplicate-check` (`samePurchase`, `newPurchases`), unchanged chain-attempt/payment/issuance counts. Local IDEM-01/X402-03/04 fault tests support deeper replay behavior; they remain local evidence.

**TODO — duplicate outcome / no-new-payment comparison:** pending recovered-run evidence or a newly accepted operator run. **TODO — screenshot 06:** same operation/result and unchanged counters. No new signature is expected.

## 7. Reject concurrent over-budget requests and revoke independently

**Action:** `f-over-budget-and-revoke` lowers Mira's remaining allowance below a package, sends two concurrent requests and requires both rejected. It revokes Prince and attempts another worker tool call. This differs from the local CAP-02 final-allowance race, which tests that only fitting exposure is admitted.

**Expected evidence:** `steps.f-over-budget-and-revoke.overBudget`, revoke result and `afterRevoke`; no additional released authority. Pause/revoke cannot cancel a proof/signature already released; show live exposure if present.

**TODO — concurrent rejection / revoked-worker response:** pending recovered-run evidence or a newly accepted operator run. **TODO — screenshot 07:** independent agent stop and limits. No payment signature is expected for denied work.

## 8. Owner exit and recovery, with privacy warning

**Action:** `g-owner-exit` prepares, signs/registers and finalizes a public exit of the largest spendable change note to the owner. Show the warning before signing. Public exit may reveal label/value and aggregate spending by subtraction.

**Expected evidence:** `steps.g-owner-exit`, `summary.json.exit` and the owner's resulting public balance. It exits one change note, not every remaining note, and does not demonstrate funded-wallet recovery.

**TODO — integrated owner-exit hash:** pending recovered-run evidence or a newly accepted operator run. **TODO — screenshot 08:** warning, finalized exit and remaining funds.

For a separate funded-wallet recovery demonstration, use the dashboard Recovery Center only after the existing merchant authority is settled or proven expired, prepare/confirm recovery to the configured owner destination and record its outcome. `demo:run` does not create this scenario. Local REC-03/REV-01/BAK-01 supply existing recovery evidence; M2 records original/change public exits separately.

**TODO — funded-wallet recovery hash and screenshot 09:** separate operator scenario, if claimed. Never fabricate a recovery to fill this field.

## Freeze and review

Export with `pnpm evidence:export`. Retain the exact source commit, lockfile hashes, circuit/setup manifest, UTC execution time and reviewer. Inspect `summary.json`, `ledger.json`, `inference-receipts.json`, useful output artifacts, negative outcomes and screenshots together. The exporter supplies artifact hashes but does not currently attach a source Git commit; add it to the submission record.

The exporter currently adds devnet explorer URLs to every signature it finds, including local integration records. Use each source file's environment to classify it; local signatures do not become devnet evidence. See [handoff gaps](../handoff.md). Secret scanning is useful but does not review private prompts or screenshot contents. Keep notes, witnesses, key files, credentials, decryption roots and encrypted backups owner-local.
