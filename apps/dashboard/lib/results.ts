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
  if (typeof r.artifactId === "string") parts.push("Saved to Outputs");
  return parts.join(" · ");
}
