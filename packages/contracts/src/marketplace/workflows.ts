import { isAddress } from "@solana/kit";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "../gateway/digest";

const solanaAddress = z.string().refine((v): boolean => isAddress(v), "must be a base58 Solana address");
const hex64 = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex SHA-256 digest");
const baseUnits = z.string().regex(/^(0|[1-9][0-9]{0,19})$/, "must be a canonical nonnegative integer");

/** How a published tool runs. Only provider adapters and external bindings connect new endpoints. */
export const TOOL_KINDS = ["managed_template", "remote_endpoint", "provider_adapter", "external_x402"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

/** Provider adapters run on a seller host with the seller's own server-side key. */
export const TOOL_PROVIDERS = ["higgsfield", "makeugc", "zernio"] as const;
export type ToolProvider = (typeof TOOL_PROVIDERS)[number];

/** `draft_external` tools prepare something that would act outside Veilo; they only ever create drafts. */
export const TOOL_EFFECTS = ["read_only", "draft_external"] as const;
export type ToolEffect = (typeof TOOL_EFFECTS)[number];

/** Typed artifacts that pass between workflow steps. They are data, never instructions. */
export const ARTIFACT_KINDS = ["text", "markdown", "json", "image_url", "video_url", "draft_post"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const WORKFLOW_CATEGORIES = ["research", "content", "media", "social", "data", "developer", "operations"] as const;
export type WorkflowCategory = (typeof WORKFLOW_CATEGORIES)[number];

export const WORKFLOW_STATUSES = ["draft", "in_review", "live", "suspended"] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

/** One step a workflow may take with a tool: its typed inputs and its single output. */
export const toolIoSchema = z
  .object({
    inputs: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
            kind: z.enum(ARTIFACT_KINDS),
            required: z.boolean(),
            maxChars: z.number().int().min(1).max(20_000),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    output: z.object({ kind: z.enum(ARTIFACT_KINDS) }).strict(),
  })
  .strict()
  .refine((io) => new Set(io.inputs.map((i) => i.name)).size === io.inputs.length, "input names must be unique");
export type ToolIo = z.infer<typeof toolIoSchema>;

/**
 * A pinned provider tool manifest. Its digest is recorded at review; a seller host that reports
 * a different manifest disables the tool until it is reviewed again.
 */
export const toolManifestSchema = z
  .object({
    provider: z.enum(TOOL_PROVIDERS),
    adapterVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
    upstream: z.string().url(),
    tools: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
            effect: z.enum(TOOL_EFFECTS),
            io: toolIoSchema,
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();
export type ToolManifest = z.infer<typeof toolManifestSchema>;

export function toolManifestDigest(manifest: ToolManifest): string {
  return sha256Hex(`veilo:tool-manifest:v1\n${canonicalJson(manifest)}`);
}

/** Where a step input comes from: a fixed value in the definition, or an earlier step's stored artifact. */
export const stepInputSchema = z.discriminatedUnion("from", [
  z.object({ from: z.literal("fixed"), value: z.string().max(20_000) }).strict(),
  z.object({ from: z.literal("run_input"), name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/) }).strict(),
  z.object({ from: z.literal("step"), step: z.number().int().min(0).max(7) }).strict(),
]);
export type StepInput = z.infer<typeof stepInputSchema>;

/** A step names a published listing version, or an operator-approved external x402 tool. */
export const STEP_TOOL_KINDS = ["listing", "external"] as const;
export type StepToolKind = (typeof STEP_TOOL_KINDS)[number];

export const workflowStepSchema = z
  .object({
    toolKind: z.enum(STEP_TOOL_KINDS),
    toolId: z.uuid(),
    /** The step's price ceiling. Publication requires it to equal the tool's published price. */
    maxBaseUnits: baseUnits,
    inputs: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), stepInputSchema),
  })
  .strict();
export type WorkflowStep = z.infer<typeof workflowStepSchema>;

export const workflowVersionInputSchema = z
  .object({
    category: z.enum(WORKFLOW_CATEGORIES),
    title: z.string().trim().min(3).max(80),
    summary: z.string().trim().min(10).max(200),
    description: z.string().trim().min(10).max(4_000),
    /** What the workflow will never do, shown on every card; required when any step drafts externally. */
    safetyPromise: z.string().trim().max(160),
    /** Inputs the buyer supplies when running it (for example a mint address or a topic). */
    runInputs: z
      .array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), label: z.string().trim().min(1).max(80), maxChars: z.number().int().min(1).max(4_000) }).strict())
      .max(4),
    steps: z.array(workflowStepSchema).min(1).max(8),
    totalMaxBaseUnits: baseUnits,
    payoutVersionId: z.uuid(),
    sampleOutput: z.string().trim().max(4_000).nullable(),
  })
  .strict();
export type WorkflowVersionInput = z.infer<typeof workflowVersionInputSchema>;

export const toolKey = (kind: StepToolKind, id: string): string => `${kind}:${id}`;

/** The published facts about a step's tool that publication checks rely on. */
export interface ToolFacts {
  toolKind: StepToolKind;
  toolId: string;
  /** True only for the listing's current, approved, published version. */
  current: boolean;
  reviewStatus: "pending" | "approved" | "rejected";
  listingStatus: "draft" | "in_review" | "published" | "rejected" | "suspended" | "archived";
  priceBaseUnits: bigint;
  recipient: string;
  effect: ToolEffect;
  io: ToolIo;
}

export interface PublishCheck {
  problems: string[];
  /** live: every step is an already-approved, published tool. review: a step's tool is still in review. */
  decision: "live" | "review" | "rejected";
}

/**
 * Automated publication checks for a workflow version. A workflow composed only of current,
 * approved, published tools goes live without review because it adds no endpoint or credential.
 */
export function checkWorkflowPublication(input: WorkflowVersionInput, tools: ReadonlyMap<string, ToolFacts>, payoutVerified: boolean): PublishCheck {
  const problems: string[] = [];
  let pendingTool = false;
  let total = 0n;
  let drafts = false;
  const runInputs = new Set(input.runInputs.map((r) => r.name));
  if (runInputs.size !== input.runInputs.length) problems.push("run input names must be unique");
  if (!payoutVerified) problems.push("creator payout wallet is not verified");

  input.steps.forEach((step, i) => {
    const t = tools.get(toolKey(step.toolKind, step.toolId));
    if (!t) {
      problems.push(`step ${i}: tool version not found`);
      return;
    }
    if (t.listingStatus === "suspended" || t.listingStatus === "archived" || t.listingStatus === "rejected" || t.reviewStatus === "rejected") {
      problems.push(`step ${i}: tool is ${t.listingStatus === "published" ? "rejected" : t.listingStatus}`);
      return;
    }
    if (t.reviewStatus === "pending") pendingTool = true;
    else if (!t.current || t.listingStatus !== "published") problems.push(`step ${i}: tool version is unpublished or superseded`);
    if (BigInt(step.maxBaseUnits) !== t.priceBaseUnits) problems.push(`step ${i}: maximum must equal the tool's published price`);
    total += BigInt(step.maxBaseUnits);
    if (t.effect === "draft_external") drafts = true;

    const names = new Set(t.io.inputs.map((x) => x.name));
    for (const name of Object.keys(step.inputs)) if (!names.has(name)) problems.push(`step ${i}: unknown input ${name}`);
    for (const want of t.io.inputs) {
      const src = step.inputs[want.name];
      if (!src) {
        if (want.required) problems.push(`step ${i}: required input ${want.name} is not mapped`);
        continue;
      }
      if (src.from === "fixed" && src.value.length > want.maxChars) problems.push(`step ${i}: fixed ${want.name} exceeds ${want.maxChars} characters`);
      if (src.from === "run_input" && !runInputs.has(src.name)) problems.push(`step ${i}: ${want.name} maps an undeclared run input`);
      if (src.from === "step") {
        if (src.step >= i) {
          problems.push(`step ${i}: ${want.name} must come from an earlier step`);
          continue;
        }
        const prior = input.steps[src.step];
        const from = prior ? tools.get(toolKey(prior.toolKind, prior.toolId)) : undefined;
        if (from && !compatible(from.io.output.kind, want.kind)) {
          problems.push(`step ${i}: ${want.name} expects ${want.kind} but step ${src.step} produces ${from.io.output.kind}`);
        }
      }
    }
  });

  if (total !== BigInt(input.totalMaxBaseUnits)) problems.push("total must equal the sum of step maxima");
  if (drafts && input.safetyPromise.length < 10) problems.push("a workflow with an external drafting step needs a safety promise");
  if (problems.length > 0) return { problems, decision: "rejected" };
  return { problems, decision: pendingTool ? "review" : "live" };
}

/** Text-like artifacts may feed text inputs; media and drafts must match exactly. */
export function compatible(output: ArtifactKind, input: ArtifactKind): boolean {
  if (output === input) return true;
  const textual: ArtifactKind[] = ["text", "markdown", "json"];
  return input === "text" && textual.includes(output);
}

/** The exact terms one owner approval covers. Any difference halts the run for a fresh approval. */
export const workflowApprovalTermsSchema = z
  .object({
    workflowVersionId: z.uuid(),
    network: z.string().min(1),
    mint: solanaAddress,
    steps: z
      .array(z.object({ toolKind: z.enum(STEP_TOOL_KINDS), toolId: z.uuid(), recipient: solanaAddress, maxBaseUnits: baseUnits, toolDigest: hex64 }).strict())
      .min(1)
      .max(8),
    totalMaxBaseUnits: baseUnits,
    runInputsDigest: hex64,
  })
  .strict();
export type WorkflowApprovalTerms = z.infer<typeof workflowApprovalTermsSchema>;

/** Every term an external tool step is paid under; a listing step is bound by its version and recipient. */
export type StepToolTerms =
  | { toolKind: "listing"; toolId: string; recipient: string }
  | {
      toolKind: "external";
      toolId: string;
      origin: string;
      resourcePath: string;
      payTo: string;
      payToAta: string;
      unitPriceBaseUnits: string;
      callsPerStep: number;
      feePayers: string[];
      rpcMethods: string[] | null;
      callTemplate: unknown;
    };

export function stepToolDigest(t: StepToolTerms): string {
  return sha256Hex(`veilo:workflow-step-tool:v1\n${canonicalJson(t)}`);
}

export function workflowApprovalDigest(terms: WorkflowApprovalTerms): string {
  return sha256Hex(`veilo:workflow-approval:v1\n${canonicalJson(terms)}`);
}

export function runInputsDigest(values: Record<string, string>): string {
  return sha256Hex(`veilo:workflow-run-inputs:v1\n${canonicalJson(values)}`);
}

/** Why a step quote may not be paid under an approval, or null when it fits exactly. */
export function stepQuoteProblem(
  terms: WorkflowApprovalTerms,
  index: number,
  quote: { toolKind: StepToolKind; toolId: string; recipient: string; totalBaseUnits: bigint; network: string; mint: string },
): string | null {
  const s = terms.steps[index];
  if (!s) return "step is not part of the approved workflow";
  if (quote.toolKind !== s.toolKind || quote.toolId !== s.toolId) return "step tool version changed";
  if (quote.recipient !== s.recipient) return "step recipient changed";
  if (quote.network !== terms.network) return "step network changed";
  if (quote.mint !== terms.mint) return "step mint changed";
  // Published tool prices are fixed, so any difference (higher or lower) means the tool changed.
  if (quote.totalBaseUnits !== BigInt(s.maxBaseUnits)) return "step price changed";
  return null;
}

/** The hire key a controller uses for a workflow step; the marketplace accepts a step's job only under it. */
export function workflowStepHireKey(runId: string, index: number): string {
  return `wf:${runId}:${index}`;
}
