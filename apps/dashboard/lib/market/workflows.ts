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
  manifest_changed: "Manifest changed — disabled",
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

export const RUN_STATUS_LABEL: Record<LocalRun["status"], string> = {
  awaiting_approval: "Waiting for your local approval",
  approved: "Approved — starting",
  running: "Running",
  halted: "Halted — needs a fresh approval",
  failed: "Stopped — later steps were not bought",
  completed: "Completed",
  rejected: "Rejected — nothing was paid",
};

/** Agents a workflow run can be charged to: switched on, with an active policy that allows hiring. */
export function hiringAgents(agents: readonly Agent[]): Agent[] {
  return agents.filter((a) => a.status === "active" && (a.activePolicy?.permissions?.allowedSkus ?? []).includes("specialist-job"));
}
