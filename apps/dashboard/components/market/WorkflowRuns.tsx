"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "../../lib/api";
import { RUN_STATUS_LABEL, type LocalRun } from "../../lib/market/workflows";
import { useAction, useResource } from "../hooks";
import { ConfirmButton, EmptyState, ErrorNotice, KV, Loading, Section, TxLink } from "../ui";
import { Address, FullValue, Money, PlainText, TestTokenNote } from "./parts";

const PAYMENT_LABEL: Record<LocalRun["steps"][number]["payment"], string> = { paid: "Paid", paying: "Paying", not_paid: "Not paid" };
const EXECUTION_LABEL: Record<LocalRun["steps"][number]["execution"], string> = { delivered: "Delivered", failed: "Failed", not_run: "Not run", pending: "Pending" };

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

/** One run: per-step funding and merchant signatures, the deliverable and why it stopped. */
export function WorkflowRunView({ runId }: { runId: string }) {
  const run = useResource(() => api<{ run: LocalRun }>("control", `/workflows/runs/${runId}`), `workflow-run:${runId}`);
  const act = useAction();
  if (run.loading && !run.data) return <Loading label="run" />;
  if (run.error || !run.data) return <ErrorNotice error={run.error} what="this run could not be loaded" onRetry={run.reload} />;
  const r = run.data.run;
  const paid = r.steps.reduce((n, s) => n + BigInt(s.paid ?? "0"), 0n);
  return (
    <>
      <p className="small">
        <Link href="/marketplace/runs">← All runs</Link>
      </p>
      <h1>
        Workflow run <span className="mono">{r.id.slice(0, 8)}</span>
      </h1>
      <p>
        <span className={statusClass(r.status)}>{RUN_STATUS_LABEL[r.status]}</span> {r.isTest ? <span className="pill pill-muted">test run</span> : null}
      </p>
      <TestTokenNote />
      <ErrorNotice error={act.error} what="the run could not be updated" />
      {r.stop ? (
        <p className={r.status === "halted" ? "notice notice-warn" : "notice notice-error"} role="status">
          Stopped: {r.stop.code}. <PlainText text={r.stop.reason ?? ""} inline />
        </p>
      ) : null}
      <KV
        rows={[
          ["Approved total", <Money key="t" amount={r.total.amount} decimals={null} />],
          ["Paid so far", <Money key="p" amount={paid.toString()} decimals={null} />],
          ["Approved by", r.approvedBy ? <Address key="a" value={r.approvedBy.startsWith("assignment:") ? null : r.approvedBy} /> : "not yet"],
          ["Approval digest", <FullValue key="d" value={r.approvalDigest} />],
        ]}
      />
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
      </div>
      <Section title="Steps">
        <ol className="timeline">
          {r.steps.map((s) => (
            <li key={s.index} className="timeline-step">
              <p className="chain-title">
                Step {s.index + 1} ({s.toolKind}) — payment <span className={s.payment === "paid" ? "pill pill-ok" : s.payment === "paying" ? "pill pill-warn" : "pill pill-muted"}>{PAYMENT_LABEL[s.payment]}</span> · execution{" "}
                <span className={s.execution === "delivered" ? "pill pill-ok" : s.execution === "failed" ? "pill pill-danger" : "pill pill-muted"}>{EXECUTION_LABEL[s.execution]}</span>
              </p>
              <KV
                rows={[
                  ["Maximum", <Money key="m" amount={s.max} decimals={null} />],
                  ["Paid", s.paid ? <Money key="p" amount={s.paid} decimals={null} /> : "—"],
                  ["Recipient", <Address key="r" value={s.recipient} />],
                  ["Private funding", <TxLink key="f" signature={s.fundingSignature} label="withdrawal" />],
                  [
                    "Merchant payment",
                    s.merchantSignatures.length === 0 ? (
                      <span key="ms" className="muted">none recorded</span>
                    ) : (
                      <span key="ms">
                        {s.merchantSignatures.map((sig, i) => (
                          <span key={sig}>
                            {i > 0 ? ", " : ""}
                            <TxLink signature={sig} label={`payment ${i + 1}`} />
                          </span>
                        ))}
                      </span>
                    ),
                  ],
                  ...(s.stop ? ([["Stop reason", <PlainText key="sr" text={`${s.stop.code}: ${s.stop.reason ?? ""}`} inline />]] as Array<[string, React.ReactNode]>) : []),
                ]}
              />
              {s.artifact ? <StepOutput runId={r.id} index={s.index} /> : null}
            </li>
          ))}
        </ol>
      </Section>
    </>
  );
}
