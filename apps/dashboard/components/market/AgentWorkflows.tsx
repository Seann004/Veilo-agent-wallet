"use client";

import Link from "next/link";
import { api } from "../../lib/api";
import { RUN_STATUS_LABEL, type LocalRun } from "../../lib/market/workflows";
import { useResource } from "../hooks";
import { EnsureMarket, useOptionalMarket } from "./MarketContext";
import { Money, PlainText } from "./parts";

interface Assignment {
  id: string;
  agentId: string;
  workflowId: string;
  versionId: string | null;
  title: string | null;
  budget: string;
  committed: string;
  status: string;
}

/** The workflows an agent may run and its recent runs; hidden until there is one. */
export function AgentWorkflows({ agentId }: { agentId: string }) {
  return (
    <EnsureMarket>
      <AgentWorkflowsPanel agentId={agentId} />
    </EnsureMarket>
  );
}

function AgentWorkflowsPanel({ agentId }: { agentId: string }) {
  const m = useOptionalMarket();
  const data = useResource(
    async () => {
      const [assignments, runs] = await Promise.all([api<{ assignments: Assignment[] }>("control", "/workflows/assignments"), api<{ runs: LocalRun[] }>("control", "/workflows/runs")]);
      return { assignments: assignments.assignments.filter((a) => a.agentId === agentId && a.status === "active"), runs: runs.runs.filter((r) => r.agentId === agentId) };
    },
    `agent-workflows:${agentId}`,
  );
  if (!data.data || (data.data.assignments.length === 0 && data.data.runs.length === 0)) return null;
  // Assignment budgets are in the workspace mint, which the marketplace token check verifies.
  const tokenDecimals = m?.token ? m.decimalsFor(m.token.mint, m.token.network) : null;
  return (
    <div className="panel">
      <h2 className="section-title">Workflows</h2>
      <ul className="plain-list">
        {data.data.assignments.map((a) => (
          <li key={a.id} className="small">
            {a.title ? <PlainText text={a.title} inline /> : "Assigned workflow"}: <Money compact amount={a.committed} decimals={tokenDecimals} /> used of{" "}
            <Money compact amount={a.budget} decimals={tokenDecimals} />
          </li>
        ))}
        {data.data.runs.slice(0, 5).map((r) => (
          <li key={r.id} className="small">
            <Link href={`/marketplace/runs/${r.id}`}>{r.status === "awaiting_approval" ? "Review and approve" : "Run"}</Link> · {RUN_STATUS_LABEL[r.status]} · up to{" "}
            <Money compact amount={r.total.amount} decimals={m?.decimalsFor(r.terms.mint, r.terms.network) ?? null} />
          </li>
        ))}
      </ul>
    </div>
  );
}
