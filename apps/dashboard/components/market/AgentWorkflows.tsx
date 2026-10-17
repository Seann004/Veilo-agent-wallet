"use client";

import Link from "next/link";
import { api } from "../../lib/api";
import { RUN_STATUS_LABEL, type LocalRun } from "../../lib/market/workflows";
import { useResource } from "../hooks";
import { Money } from "./parts";

interface Assignment {
  id: string;
  agentId: string;
  workflowId: string;
  budget: string;
  committed: string;
  status: string;
}

/** The workflows an agent may run and its recent runs; hidden until there is one. */
export function AgentWorkflows({ agentId }: { agentId: string }) {
  const data = useResource(
    async () => {
      const [assignments, runs] = await Promise.all([api<{ assignments: Assignment[] }>("control", "/workflows/assignments"), api<{ runs: LocalRun[] }>("control", "/workflows/runs")]);
      return { assignments: assignments.assignments.filter((a) => a.agentId === agentId), runs: runs.runs.filter((r) => r.agentId === agentId) };
    },
    `agent-workflows:${agentId}`,
  );
  if (!data.data || (data.data.assignments.length === 0 && data.data.runs.length === 0)) return null;
  return (
    <div className="panel">
      <h2 className="section-title">Workflows</h2>
      <ul className="plain-list">
        {data.data.assignments.map((a) => (
          <li key={a.id} className="small">
            <Money amount={a.committed} decimals={null} /> used of <Money amount={a.budget} decimals={null} />
          </li>
        ))}
        {data.data.runs.slice(0, 5).map((r) => (
          <li key={r.id} className="small">
            <Link href={`/marketplace/runs/${r.id}`}>Run</Link> · {RUN_STATUS_LABEL[r.status]}
          </li>
        ))}
      </ul>
    </div>
  );
}
