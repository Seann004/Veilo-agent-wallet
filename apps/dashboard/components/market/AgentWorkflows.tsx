"use client";

import Link from "next/link";
import { api } from "../../lib/api";
import { RUN_STATUS_LABEL, type LocalRun } from "../../lib/market/workflows";
import { useResource } from "../hooks";
import { ErrorNotice, Loading, Section } from "../ui";
import { Address, Money } from "./parts";

interface Assignment {
  id: string;
  agentId: string;
  workflowId: string;
  budget: string;
  committed: string;
  status: string;
}

interface Binding {
  id: string;
  label: string;
  origin: string;
  resourcePath: string;
  payTo: string;
  unitPrice: { amount: string };
  maxCalls: number;
  status: string;
}

/** An agent's paid tools, assigned workflows and workflow runs, from local control only. */
export function AgentWorkflows({ agentId }: { agentId: string }) {
  const data = useResource(
    async () => {
      const [assignments, runs, bindings] = await Promise.all([
        api<{ assignments: Assignment[] }>("control", "/workflows/assignments"),
        api<{ runs: LocalRun[] }>("control", "/workflows/runs"),
        api<{ bindings: Binding[] }>("control", "/external-bindings"),
      ]);
      return { assignments: assignments.assignments.filter((a) => a.agentId === agentId), runs: runs.runs.filter((r) => r.agentId === agentId), bindings: bindings.bindings };
    },
    `agent-workflows:${agentId}`,
  );
  return (
    <Section title="Tools and workflows">
      {data.loading && !data.data ? <Loading label="workflows" /> : null}
      <ErrorNotice error={data.error} what="workflows are unavailable (the marketplace or wallet may not be configured)" />
      {data.data ? (
        <>
          <h3>Approved data tools</h3>
          {data.data.bindings.filter((b) => b.status === "approved").length === 0 ? (
            <p className="small muted">No external x402 tools are approved for this workspace.</p>
          ) : (
            <ul>
              {data.data.bindings
                .filter((b) => b.status === "approved")
                .map((b) => (
                  <li key={b.id}>
                    {b.label} — {b.origin}
                    {b.resourcePath}, up to {b.maxCalls} calls at <Money amount={b.unitPrice.amount} decimals={null} /> each to <Address value={b.payTo} />
                  </li>
                ))}
            </ul>
          )}
          <h3>Assigned workflows</h3>
          {data.data.assignments.length === 0 ? (
            <p className="small muted">
              None. Use “Add to agent” on a <Link href="/marketplace">workflow</Link>.
            </p>
          ) : (
            <ul>
              {data.data.assignments.map((a) => (
                <li key={a.id}>
                  Workflow <span className="mono">{a.workflowId.slice(0, 8)}</span> — <Money amount={a.committed} decimals={null} /> committed of <Money amount={a.budget} decimals={null} /> ({a.status})
                </li>
              ))}
            </ul>
          )}
          <h3>Workflow runs</h3>
          {data.data.runs.length === 0 ? (
            <p className="small muted">No runs yet.</p>
          ) : (
            <ul>
              {data.data.runs.map((r) => (
                <li key={r.id}>
                  <Link href={`/marketplace/runs/${r.id}`}>Run {r.id.slice(0, 8)}</Link> — {RUN_STATUS_LABEL[r.status]} · {r.steps.filter((s) => s.payment === "paid").length}/{r.steps.length} steps paid
                  {r.steps.some((s) => s.artifact) ? " · outputs stored" : ""}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </Section>
  );
}
