"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "../../lib/api";
import { RUN_STATUS_LABEL, runHeadline, stepStateLabel, type LocalRun, type RunHeadline, type StepStateLabel } from "../../lib/market/workflows";
import { useAction, useResource } from "../hooks";
import { ConfirmButton, EmptyState, ErrorNotice, KV, Loading, Section, TxLink } from "../ui";
import { Address, FullValue, Money, PlainText, TestTokenNote } from "./parts";

const HEAD_CLASS: Record<RunHeadline, string> = { Running: "pill", Waiting: "pill pill-warn", Completed: "pill pill-ok", Failed: "pill pill-danger", Halted: "pill pill-warn" };
const STATE_CLASS: Record<StepStateLabel, string> = {
  "Not started": "pill pill-muted",
  "Getting a quote": "pill pill-warn",
  Paying: "pill pill-warn",
  Paid: "pill pill-ok",
  Delivered: "pill pill-ok",
  Failed: "pill pill-danger",
};

const statusClass = (s: LocalRun["status"]) =>
  s === "completed" ? "pill pill-ok" : s === "failed" || s === "rejected" ? "pill pill-danger" : s === "halted" || s === "awaiting_approval" ? "pill pill-warn" : "pill";

/** Your workflow runs, as your local control service records them. */
export function WorkflowRunList() {
  const runs = useResource(() => api<{ runs: LocalRun[] }>("control", "/workflows/runs"), "workflow-runs");
  return (
    <>
      <h1>Workflow runs</h1>
      <TestTokenNote />
      {runs.loading && !runs.data ? <Loading label="runs" /> : null}
      <ErrorNotice error={runs.error} what="your runs could not be loaded (sign in to the local dashboard first)" onRetry={runs.reload} />
      {runs.data && runs.data.runs.length === 0 ? (
        <EmptyState>
          No runs yet. <Link href="/marketplace">Browse workflows</Link>.
        </EmptyState>
      ) : null}
      {runs.data && runs.data.runs.length > 0 ? (
        <ul className="job-list">
          {runs.data.runs.map((r) => (
            <li key={r.id}>
              <Link href={`/marketplace/runs/${r.id}`}>Run {r.id.slice(0, 8)}</Link> <span className={statusClass(r.status)}>{RUN_STATUS_LABEL[r.status]}</span>
              {r.isTest ? <span className="pill pill-muted"> test run</span> : null} · {r.steps.filter((s) => s.payment === "paid").length}/{r.steps.length} steps paid · total{" "}
              <Money amount={r.total.amount} decimals={null} />
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function StepOutput({ runId, index }: { runId: string; index: number }) {
  const [open, setOpen] = useState(false);
  const out = useResource(
    () => (open ? api<{ kind: string | null; text: string; sha256: string }>("control", `/workflows/runs/${runId}/steps/${index}/artifact`) : Promise.resolve(null)),
    `run-artifact:${runId}:${index}:${open}`,
  );
  if (!open) {
    return (
      <button type="button" className="btn btn-small" onClick={() => setOpen(true)}>
        Show stored output
      </button>
    );
  }
  if (out.loading) return <Loading label="output" />;
  if (out.error || !out.data) return <ErrorNotice error={out.error} what="the stored output could not be loaded" />;
  return (
    <div className="artifact">
      <p className="small">
        Untrusted output ({out.data.kind ?? "text"}), sha256 <FullValue value={out.data.sha256} />. Links are not opened or loaded.
      </p>
      <pre className="plain-text">
        <PlainText text={out.data.text.slice(0, 20_000)} />
      </pre>
    </div>
  );
}

/** One run: status, why it stopped or is waiting, and each step's payment and delivery. */
export function WorkflowRunView({ runId }: { runId: string }) {
  const run = useResource(() => api<{ run: LocalRun }>("control", `/workflows/runs/${runId}`), `workflow-run:${runId}`);
  const act = useAction();
  if (run.loading && !run.data) return <Loading label="run" />;
  if (run.error || !run.data) return <ErrorNotice error={run.error} what="this run could not be loaded" onRetry={run.reload} />;
  const r = run.data.run;
  const paid = r.steps.reduce((n, s) => n + BigInt(s.paid ?? "0"), 0n);
  const head = runHeadline(r);
  const reason = r.waiting?.reason ?? r.stop?.reason ?? null;
  return (
    <>
      <p className="small">
        <Link href="/marketplace/runs">← All runs</Link>
      </p>
      <h1>
        Workflow run <span className="mono">{r.id.slice(0, 8)}</span>
      </h1>
      <div className="run-head">
        <span className={HEAD_CLASS[head]}>{head}</span>
        {r.isTest ? <span className="pill pill-muted">test run</span> : null}
        <span className="small muted">
          Paid <Money compact amount={paid.toString()} decimals={null} /> of <Money compact amount={r.total.amount} decimals={null} />
        </span>
      </div>
      <p className="run-reason" role="status">
        {reason ? <PlainText text={reason} inline /> : head === "Completed" ? "All steps are done." : head === "Running" ? "Buying the steps in order." : RUN_STATUS_LABEL[r.status]}
      </p>
      <ErrorNotice error={act.error} what="the run could not be updated" />
      <div className="actions">
        {r.status === "running" || r.status === "approved" ? (
          <button type="button" className="btn" disabled={act.busy} onClick={async () => (await act.run(() => api("control", `/workflows/runs/${r.id}/advance`, { method: "POST", body: {} }))) && run.reload()}>
            Check progress
          </button>
        ) : null}
        {r.status === "awaiting_approval" || r.status === "halted" ? (
          <>
            <ConfirmButton
              label={r.status === "halted" ? "Approve again and continue" : "Approve and run"}
              confirmLabel="Confirm approval"
              disabled={act.busy}
              onConfirm={async () => {
                if (await act.run(() => api("control", `/workflows/runs/${r.id}/approve`, { method: "POST", body: { approvalDigest: r.approvalDigest } }))) run.reload();
              }}
            />
            <ConfirmButton
              label="Reject"
              confirmLabel="Confirm reject"
              danger
              disabled={act.busy}
              onConfirm={async () => {
                if (await act.run(() => api("control", `/workflows/runs/${r.id}/reject`, { method: "POST", body: {} }))) run.reload();
              }}
            />
          </>
        ) : null}
        <button type="button" className="btn" disabled={run.loading} onClick={() => run.reload()}>
          Refresh
        </button>
      </div>
      <Section title="Steps">
        <ol className="timeline">
          {r.steps.map((s) => {
            const label = stepStateLabel(s);
            return (
              <li key={s.index} className="timeline-step">
                <p className="chain-title">
                  {s.index + 1}. {s.toolKind === "listing" ? "Marketplace tool" : "Paid tool"} <span className={STATE_CLASS[label]}>{label}</span>
                </p>
                <p className="small flush">
                  {s.paid ? (
                    <>
                      Paid <Money compact amount={s.paid} decimals={null} />
                    </>
                  ) : (
                    <>
                      Up to <Money compact amount={s.max} decimals={null} />
                    </>
                  )}{" "}
                  to <Address value={s.recipient} />
                </p>
                {s.fundingSignature || s.merchantSignatures.length > 0 ? (
                  <p className="small flush">
                    {s.fundingSignature ? <TxLink signature={s.fundingSignature} label="Funding" /> : null}
                    {s.merchantSignatures.map((sig, i) => (
                      <span key={sig}>
                        {s.fundingSignature || i > 0 ? " · " : ""}
                        <TxLink signature={sig} label={s.merchantSignatures.length > 1 ? `Payment ${i + 1}` : "Payment"} />
                      </span>
                    ))}
                  </p>
                ) : null}
                {s.stop ? (
                  <p className="small flush">
                    <PlainText text={`${s.stop.code}: ${s.stop.reason ?? ""}`} inline />
                  </p>
                ) : null}
                {s.artifact ? <StepOutput runId={r.id} index={s.index} /> : null}
              </li>
            );
          })}
        </ol>
      </Section>
      <details className="tech-details">
        <summary>Technical details</summary>
        <KV
          rows={[
            ["Approved by", r.approvedBy ? <Address key="a" value={r.approvedBy.startsWith("assignment:") ? null : r.approvedBy} /> : "not yet"],
            ["Approval digest", <FullValue key="d" value={r.approvalDigest} />],
          ]}
        />
      </details>
      <TestTokenNote />
    </>
  );
}
