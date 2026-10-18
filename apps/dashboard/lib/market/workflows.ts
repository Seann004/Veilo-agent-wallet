import type { Agent } from "../types";
import type { ArtifactKind, StepInput, ToolIo, WorkflowCategory } from "@veilo/contracts/marketplace";

export const CATEGORIES: ReadonlyArray<{ id: WorkflowCategory; label: string }> = [
  { id: "research", label: "Research" },
  { id: "content", label: "Content" },
  { id: "media", label: "Media" },
  { id: "social", label: "Social" },
  { id: "data", label: "Data" },
  { id: "developer", label: "Developer" },
  { id: "operations", label: "Operations" },
];

export const categoryLabel = (id: string): string => CATEGORIES.find((c) => c.id === id)?.label ?? id;

/** One step of a live workflow as the public catalogue describes it. Text fields are untrusted. */
export interface PublicStep {
  index: number;
  toolKind: "listing" | "external";
  toolId: string;
  title: string | null;
  sellerName: string | null;
  slug: string | null;
  kind: string;
  provider: string | null;
  effect: "read_only" | "draft_external";
  priceBaseUnits: string;
  recipient: string | null;
  inputs: Record<string, StepInput>;
  output: { kind: ArtifactKind } | null;
  providerStatus?: string | null;
}

export interface WorkflowEntry {
  workflow_id: string;
  version_id: string;
  slug: string;
  creator_name: string;
  demo: boolean;
  category: WorkflowCategory;
  title: string;
  summary: string;
  description?: string;
  safety_promise: string;
  total_base_units: string | number;
  fee_bps: number;
  network: string;
  mint: string;
  decimals: number;
  steps: PublicStep[];
  run_inputs?: Array<{ name: string; label: string; maxChars: number }>;
  sample_output?: string | null;
  paid_runs: number;
  published_at: string;
}

export interface ToolEntry {
  toolKind: "listing" | "external";
  toolId: string;
  slug: string;
  title: string;
  summary: string;
  by: string;
  kind: string;
  provider: string | null;
  effect: "read_only" | "draft_external";
  io: ToolIo;
  priceBaseUnits: string;
  recipient: string;
  network: string;
  mint: string;
  decimals: number;
  badge: "approved" | "in_review" | "provider_not_configured" | "manifest_changed" | "suspended";
}

export const BADGE_LABEL: Record<ToolEntry["badge"], string> = {
  approved: "Approved",
  in_review: "In review",
  provider_not_configured: "Provider not configured",
  manifest_changed: "Manifest changed: disabled",
  suspended: "Suspended",
};

export const BADGE_CLASS: Record<ToolEntry["badge"], string> = {
  approved: "pill pill-ok",
  in_review: "pill pill-warn",
  provider_not_configured: "pill pill-muted",
  manifest_changed: "pill pill-danger",
  suspended: "pill pill-danger",
};

/** A short text glyph per tool kind for the chain view; no images are loaded. */
export function kindGlyph(kind: string, provider: string | null): string {
  if (provider === "higgsfield") return "IMG";
  if (provider === "makeugc") return "VID";
  if (provider === "zernio") return "POST";
  if (kind === "external_x402") return "RPC";
  if (kind === "mcp") return "MCP";
  if (kind === "managed_template") return "LLM";
  return "API";
}

export const WORKFLOW_STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  in_review: "In review",
  live: "Live",
  suspended: "Suspended",
};

/** A run as the local controller reports it. Payment and execution are separate facts. */
export interface LocalRun {
  id: string;
  cloudRunId: string | null;
  workflowVersionId: string;
  agentId: string;
  status: "awaiting_approval" | "approved" | "running" | "halted" | "failed" | "completed" | "rejected";
  isTest: boolean;
  requestedBy: "owner" | "agent";
  approvedBy: string | null;
  approvalDigest: string;
  terms: { steps: Array<{ toolKind: string; toolId: string; recipient: string; maxBaseUnits: string; toolDigest: string }>; totalMaxBaseUnits: string; network: string; mint: string };
  total: { amount: string; unit: string };
  stop: { code: string; reason: string | null } | null;
  /** Why the run is temporarily paused; null when it is not waiting. */
  waiting?: { code: string; reason: string | null; since: string | null } | null;
  steps: Array<{
    index: number;
    toolKind: string;
    toolId: string;
    recipient: string;
    max: string;
    state: string;
    payment: "paid" | "paying" | "not_paid";
    execution: "delivered" | "failed" | "not_run" | "pending";
    paid: string | null;
    jobId: string | null;
    purchaseId: string | null;
    fundingSignature: string | null;
    merchantSignatures: string[];
    artifact: { kind: string | null; sha256: string; untrusted: true } | null;
    stop: { code: string; reason: string | null } | null;
  }>;
}

export type StepStateLabel = "Not started" | "Getting a quote" | "Paying" | "Paid" | "Delivered" | "Failed";

/** One plain state per step, taken from what the controller recorded. */
export function stepStateLabel(s: Pick<LocalRun["steps"][number], "state" | "payment" | "execution" | "stop">): StepStateLabel {
  if (s.execution === "delivered") return "Delivered";
  if (s.execution === "failed" || s.state === "failed" || s.stop) return "Failed";
  if (s.state === "paying" || s.payment === "paying") return "Paying";
  if (s.payment === "paid") return "Paid";
  if (s.state === "hiring") return "Getting a quote";
  return "Not started";
}

export type RunHeadline = "Running" | "Waiting" | "Completed" | "Failed" | "Halted";

export function runHeadline(r: Pick<LocalRun, "status" | "waiting">): RunHeadline {
  if (r.status === "completed") return "Completed";
  if (r.status === "failed" || r.status === "rejected") return "Failed";
  if (r.status === "halted") return "Halted";
  if (r.status === "awaiting_approval" || r.waiting) return "Waiting";
  return "Running";
}

export const RUN_STATUS_LABEL: Record<LocalRun["status"], string> = {
  awaiting_approval: "Waiting for your local approval",
  approved: "Approved: starting",
  running: "Running",
  halted: "Halted: needs a fresh approval",
  failed: "Stopped: later steps were not bought",
  completed: "Completed",
  rejected: "Rejected: nothing was paid",
};

/** Agents a workflow run can be charged to: switched on, with an active policy that allows hiring. */
export function hiringAgents(agents: readonly Agent[]): Agent[] {
  return agents.filter((a) => a.status === "active" && (a.activePolicy?.permissions?.allowedSkus ?? []).includes("specialist-job"));
}

/**
 * A stop or wait reason without its leading error codes ("SERVICE_NOT_ALLOWED: hire not created: …"
 * reads "Hire not created: …"). The codes are returned separately for a tooltip or technical details.
 */
export function plainReason(text: string | null | undefined): { text: string; codes: string[] } {
  let rest = (text ?? "").trim();
  const codes: string[] = [];
  for (let m = /^([A-Z][A-Z0-9_]{2,}):\s*/.exec(rest); m; m = /^([A-Z][A-Z0-9_]{2,}):\s*/.exec(rest)) {
    codes.push(m[1] as string);
    rest = rest.slice(m[0].length);
  }
  return { text: rest.charAt(0).toUpperCase() + rest.slice(1), codes };
}

const isFailedRun = (r: Pick<LocalRun, "status">) => r.status === "failed" || r.status === "rejected";

/**
 * Splits newest-first runs into those to show and the failed or rejected runs older than the
 * newest run that succeeded or is still active. Nothing is deleted; hidden runs stay one click away.
 */
export function partitionRuns<T extends Pick<LocalRun, "status">>(runs: readonly T[], hideOldFailed: boolean): { shown: T[]; olderFailed: T[] } {
  const newestGood = runs.findIndex((r) => !isFailedRun(r));
  if (newestGood < 0) return { shown: [...runs], olderFailed: [] };
  const olderFailed = runs.filter((r, i) => i > newestGood && isFailedRun(r));
  return { shown: hideOldFailed ? runs.filter((r) => !olderFailed.includes(r)) : [...runs], olderFailed };
}

/** Step titles of a catalogued workflow version; a missing title reads "Step N". */
export function stepTitles(entry: Pick<WorkflowEntry, "steps"> | undefined, count: number): string[] {
  return Array.from({ length: count }, (_, i) => entry?.steps[i]?.title?.trim() || `Step ${i + 1}`);
}

/** Agents that can be given a workflow: custom agents that are on and allowed to hire. */
export function workflowAgents(agents: readonly Agent[]): Agent[] {
  return hiringAgents(agents).filter((a) => a.role === "custom");
}
