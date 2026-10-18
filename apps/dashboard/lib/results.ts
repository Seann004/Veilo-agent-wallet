import { plainOutcome, skuLabel, taskStateLabel } from "./labels";
import type { Job, Task } from "./types";

/** Summarizes a finished job; a task's own state wins over the job's lease outcome. */
export function summarizeResult(job: Job | undefined, task?: Task): string {
  if (!job) return "No result yet";
  const r = job.result ?? {};
  if (typeof r.detail === "string") return `${String(r.decision ?? job.state)}: ${r.detail}`;
  if (typeof r.error === "string") return `${job.state}: ${r.error}`;
  const parts = [taskStateLabel(task && task.id === job.taskId ? task.state : job.state)];
  if (Array.isArray(r.paid)) {
    for (const p of r.paid as Array<{ sku?: unknown; outcome?: unknown }>) {
      if (typeof p.sku === "string" && typeof p.outcome === "string") parts.push(`${skuLabel(p.sku)}: ${plainOutcome(p.outcome)}`);
    }
  }
  const hire = r.hire as { proposalId?: unknown; code?: unknown } | null | undefined;
  if (hire && typeof hire === "object") {
    parts.push(typeof hire.proposalId === "string" ? "Wants to hire a specialist (waits for your approval unless you pre-approved the listing)" : plainOutcome(`Hire refused (${String(hire.code)})`));
  }
  const run = workflowRunOf(job);
  if (run) parts.push(run.status === "awaiting_approval" ? `Proposed the workflow "${run.title}" (waits for your approval)` : `Started the workflow "${run.title}" under your assignment`);
  else if (r.workflowRun && typeof r.workflowRun === "object") parts.push(plainOutcome(`Workflow not proposed (${String((r.workflowRun as { code?: unknown }).code)})`));
  if (typeof r.artifactId === "string") parts.push("Saved to Outputs");
  return parts.join(" · ");
}

export interface ProposedWorkflowRun {
  runId: string;
  status: string;
  title: string;
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The workflow run a job proposed, as recorded when the job finished; null when there is none. */
export function workflowRunOf(job: Job | undefined): ProposedWorkflowRun | null {
  const w = (job?.result ?? {}).workflowRun as { runId?: unknown; status?: unknown; title?: unknown } | null | undefined;
  if (!w || typeof w.runId !== "string" || !RUN_ID.test(w.runId)) return null;
  return { runId: w.runId, status: typeof w.status === "string" ? w.status : "unknown", title: typeof w.title === "string" && w.title.trim() !== "" ? w.title.slice(0, 120) : "workflow" };
}
