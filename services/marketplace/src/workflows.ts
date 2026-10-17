import {
  checkWorkflowPublication,
  MARKETPLACE_LIMITS,
  PROVIDER_MANIFESTS,
  TOOL_EFFECTS,
  toolIoSchema,
  toolKey,
  toolManifestDigest,
  TOOL_PROVIDERS,
  WORKFLOW_CATEGORIES,
  workflowApprovalDigest,
  workflowApprovalTermsSchema,
  payerBindingMessage,
  stepToolDigest,
  workflowStepHireKey,
  workflowVersionInputSchema,
  type ToolFacts,
  type ToolIo,
  type WorkflowVersionInput,
} from "@veilo/contracts/marketplace";
import { createHash } from "node:crypto";
import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { verifyEd25519, type ControllerActor, type UserActor } from "./auth";
import { checkTransfer } from "./chain";
import { must } from "./db";
import { MarketError } from "./errors";
import type { Deps } from "./service";

type Route = (handler: (req: Request & { rawBody?: Buffer }, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => void;

export interface WorkflowRouteHelpers {
  route: Route;
  user(req: Request, write?: boolean): Promise<UserActor>;
  workspaceOf(actor: UserActor): Promise<string>;
  controller(req: Request & { rawBody?: Buffer }): Promise<ControllerActor>;
  operator(req: Request): void;
  sellerHost(req: Request): Promise<{ kind: "managed" } | { kind: "remote"; sellerId: string }>;
}

const uuid = z.uuid();
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/);
const baseUnits = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const signatureB58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/);

/** Dashboard routes under /marketplace that a workflow slug must not shadow. */
const RESERVED_SLUGS = new Set(["jobs", "seller", "agents", "approvals", "create", "tools", "runs", "c", "w"]);

const toolProfileSchema = z
  .object({
    toolKind: z.enum(["managed_template", "remote_endpoint", "provider_adapter"]),
    provider: z.enum(TOOL_PROVIDERS).nullable(),
    toolName: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/).nullable(),
    effect: z.enum(TOOL_EFFECTS),
    io: toolIoSchema,
  })
  .strict();

const externalToolSchema = z
  .object({
    slug,
    title: z.string().trim().min(3).max(80),
    summary: z.string().trim().min(10).max(300),
    origin: z.string().regex(/^https:\/\/[a-z0-9.-]+$/),
    resourcePath: z.string().regex(/^\/[A-Za-z0-9._~/-]{0,200}(\/\*)?$/),
    payTo: address,
    payToAta: address,
    unitPriceBaseUnits: baseUnits,
    callsPerStep: z.number().int().min(1).max(100),
    feePayers: z.array(address).min(1).max(4),
    rpcMethods: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)).min(1).max(32).optional(),
    io: toolIoSchema,
    callTemplate: z
      .array(z.object({ method: z.enum(["GET", "POST"]), path: z.string().regex(/^\/[A-Za-z0-9._~/-]{0,200}$/), body: z.unknown().optional() }).strict())
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((t, ctx) => {
    const problem = callTemplateProblem(t);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

const PLACEHOLDER = /^\{\{([a-z][a-z0-9_]{0,39})\}\}$/;

/** Every call stays on the approved path and names an allowed method; placeholders name declared inputs. */
export function callTemplateProblem(t: { resourcePath: string; callsPerStep: number; rpcMethods?: string[] | undefined; io: ToolIo; callTemplate: Array<{ method: string; path: string; body?: unknown }> }): string | null {
  if (t.callTemplate.length !== t.callsPerStep) return "the call template must list exactly one call per paid call";
  const prefix = t.resourcePath.endsWith("/*") ? t.resourcePath.slice(0, -1) : null;
  const inputs = new Set(t.io.inputs.map((i) => i.name));
  for (const [i, c] of t.callTemplate.entries()) {
    const onPath = prefix === null ? c.path === t.resourcePath : c.path.startsWith(prefix) && c.path.length > prefix.length;
    if (!onPath || c.path.split("/").some((seg) => seg === "." || seg === "..")) return `call ${i} leaves the approved resource path`;
    if (c.method === "GET" && c.body !== undefined) return `call ${i} GET cannot carry a body`;
    if (c.body !== undefined && Buffer.byteLength(JSON.stringify(c.body)) > 4096) return `call ${i} body is too large`;
    if (t.rpcMethods) {
      const m = (c.body as { method?: unknown } | undefined)?.method;
      if (typeof m !== "string" || !t.rpcMethods.includes(m)) return `call ${i} RPC method is not allowed`;
    }
    const bad: string[] = [];
    JSON.stringify(c.body ?? null, (_k, v: unknown) => {
      if (typeof v === "string" && v.includes("{{")) {
        const m = PLACEHOLDER.exec(v);
        if (!m || !inputs.has(m[1] as string)) bad.push(v);
      }
      return v;
    });
    if (bad.length > 0) return `call ${i} has a placeholder that is not a whole declared input`;
  }
  return null;
}

const runReportSchema = z
  .object({
    status: z.enum(["awaiting_approval", "approved", "running", "halted", "failed", "completed", "rejected"]),
    stopReason: z.string().max(300).nullable(),
    steps: z
      .array(
        z
          .object({
            index: z.number().int().min(0).max(7),
            paymentStatus: z.enum(["not_started", "quoted", "paying", "paid", "not_paid", "uncertain"]),
            executionStatus: z.enum(["not_started", "running", "delivered", "failed", "not_run"]),
            jobId: uuid.nullable(),
            paidBaseUnits: baseUnits.nullable(),
            fundingSignature: signatureB58.nullable(),
            merchantSignatures: z.array(signatureB58).max(100),
            artifactSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
            stopReason: z.string().max(300).nullable(),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();

/** A plain specialist listing takes one text brief and returns its declared format. */
function defaultIo(outputFormat: string): ToolIo {
  return {
    inputs: [{ name: "brief", kind: "text", required: true, maxChars: MARKETPLACE_LIMITS.maxBriefChars }],
    output: { kind: outputFormat === "json" ? "json" : "markdown" },
  };
}

interface ListingFactRow {
  id: string;
  listing_id: string;
  price_base_units: string | number;
  review_status: "pending" | "approved" | "rejected";
  output_schema: { format?: string };
}

/** Loads the published facts of every step's tool with the server role; callers never supply them. */
export async function loadToolFacts(deps: Deps, steps: ReadonlyArray<{ toolKind: string; toolId: string }>): Promise<Map<string, ToolFacts>> {
  const facts = new Map<string, ToolFacts>();
  const listingIds = steps.filter((s) => s.toolKind === "listing").map((s) => s.toolId);
  const externalIds = steps.filter((s) => s.toolKind === "external").map((s) => s.toolId);
  if (listingIds.length > 0) {
    const [versions, profiles, catalog] = await Promise.all([
      deps.db.admin.from("listing_versions").select("id, listing_id, price_base_units, review_status, output_schema").in("id", listingIds),
      deps.db.admin.from("tool_profiles").select("listing_version_id, effect, io, provider_status").in("listing_version_id", listingIds),
      deps.db.admin.from("catalog_entries").select("listing_version_id, recipient").in("listing_version_id", listingIds),
    ]);
    const prof = new Map(((profiles.data ?? []) as Array<{ listing_version_id: string; effect: ToolFacts["effect"]; io: ToolIo; provider_status: string }>).map((p) => [p.listing_version_id, p]));
    const recip = new Map(((catalog.data ?? []) as Array<{ listing_version_id: string; recipient: string }>).map((c) => [c.listing_version_id, c.recipient]));
    const rows = (versions.data ?? []) as unknown as ListingFactRow[];
    const parents = rows.length === 0 ? [] : ((await deps.db.admin.from("listings").select("id, status, current_version_id").in("id", rows.map((r) => r.listing_id))).data ?? []);
    const listingOf = new Map((parents as Array<{ id: string; status: ToolFacts["listingStatus"]; current_version_id: string | null }>).map((l) => [l.id, l]));
    for (const v of rows) {
      const p = prof.get(v.id);
      const parent = listingOf.get(v.listing_id);
      const listingStatus = p?.provider_status === "manifest_changed" ? "suspended" : (parent?.status ?? "draft");
      facts.set(toolKey("listing", v.id), {
        toolKind: "listing",
        toolId: v.id,
        current: parent?.current_version_id === v.id && parent.status === "published",
        reviewStatus: v.review_status,
        listingStatus,
        priceBaseUnits: BigInt(String(v.price_base_units)),
        recipient: recip.get(v.id) ?? "",
        effect: p?.effect ?? "read_only",
        io: p?.io ?? defaultIo(v.output_schema?.format ?? "markdown"),
      });
    }
  }
  if (externalIds.length > 0) {
    const { data } = await deps.db.admin.from("external_tools").select("id, status, pay_to, unit_price_base_units, calls_per_step, io").in("id", externalIds);
    for (const e of (data ?? []) as Array<{ id: string; status: string; pay_to: string; unit_price_base_units: string | number; calls_per_step: number; io: ToolIo }>) {
      facts.set(toolKey("external", e.id), {
        toolKind: "external",
        toolId: e.id,
        current: e.status === "approved",
        reviewStatus: e.status === "approved" ? "approved" : e.status === "pending" ? "pending" : "rejected",
        listingStatus: e.status === "approved" ? "published" : e.status === "pending" ? "in_review" : "suspended",
        priceBaseUnits: BigInt(String(e.unit_price_base_units)) * BigInt(e.calls_per_step),
        recipient: e.pay_to,
        effect: "read_only",
        io: e.io,
      });
    }
  }
  return facts;
}

/** Each approved step's tool digest must match the tool facts this marketplace stores now. */
async function toolDigestProblem(deps: Deps, terms: z.infer<typeof workflowApprovalTermsSchema>): Promise<string | null> {
  for (const [i, s] of terms.steps.entries()) {
    let expected: string | null = null;
    if (s.toolKind === "listing") {
      const c = (await deps.db.admin.from("catalog_entries").select("recipient").eq("listing_version_id", s.toolId).maybeSingle()).data as { recipient: string } | null;
      if (c) expected = stepToolDigest({ toolKind: "listing", toolId: s.toolId, recipient: c.recipient });
    } else {
      const e = (await deps.db.admin.from("external_tools").select("id, origin, resource_path, pay_to, pay_to_ata, unit_price_base_units, calls_per_step, fee_payers, rpc_methods, call_template").eq("id", s.toolId).maybeSingle()).data as {
        id: string;
        origin: string;
        resource_path: string;
        pay_to: string;
        pay_to_ata: string;
        unit_price_base_units: string | number;
        calls_per_step: number;
        fee_payers: string[];
        rpc_methods: string[] | null;
        call_template: unknown;
      } | null;
      if (e) {
        expected = stepToolDigest({
          toolKind: "external",
          toolId: e.id,
          origin: e.origin,
          resourcePath: e.resource_path,
          payTo: e.pay_to,
          payToAta: e.pay_to_ata,
          unitPriceBaseUnits: String(e.unit_price_base_units),
          callsPerStep: e.calls_per_step,
          feePayers: e.fee_payers,
          rpcMethods: e.rpc_methods,
          callTemplate: e.call_template,
        });
      }
    }
    if (expected === null) return `step ${i} tool is not available`;
    if (expected !== s.toolDigest) return `step ${i} tool terms differ from the approved terms`;
  }
  return null;
}

type ReportedStep = z.infer<typeof runReportSchema>["steps"][number];

/**
 * A controller's "paid" claim is never trusted on its own. A listing step is paid only by the
 * receipt the marketplace already verified for that step's job; an external step only by
 * finalized transfers of exactly the unit price from the step's bound payer to the tool's
 * recipient. The database records each signature against one step, atomically with the report.
 */
export async function verifiedSteps(deps: Deps, workspaceId: string, runId: string, reported: ReportedStep[]): Promise<ReportedStep[]> {
  const { db, chain, config } = deps;
  const run = (await db.admin.from("workflow_runs").select("id").eq("id", runId).eq("buyer_workspace_id", workspaceId).maybeSingle()).data;
  if (!run) throw new MarketError("NOT_FOUND", "workflow run not found");
  const rows = ((await db.admin.from("workflow_run_steps").select("step_index, tool_kind, tool_id, max_base_units, payer, payer_bound_slot").eq("run_id", runId)).data ?? []) as Array<{
    step_index: number;
    tool_kind: "listing" | "external";
    tool_id: string;
    max_base_units: string | number;
    payer: string | null;
    payer_bound_slot: string | number | null;
  }>;
  const out: ReportedStep[] = [];
  for (const s of reported) {
    if (s.paymentStatus !== "paid") {
      out.push({ ...s, paidBaseUnits: null, merchantSignatures: [] });
      continue;
    }
    const row = rows.find((r) => r.step_index === s.index);
    if (!row) throw new MarketError("INVALID_REQUEST", `step ${s.index} is not part of this run`);
    if (row.tool_kind === "listing") {
      if (s.jobId === null) throw new MarketError("INVALID_REQUEST", `step ${s.index} has no job`);
      const job = (await db.admin.from("jobs").select("id, buyer_workspace_id, listing_version_id, idempotency_key").eq("id", s.jobId).maybeSingle()).data as {
        buyer_workspace_id: string;
        listing_version_id: string;
        idempotency_key: string;
      } | null;
      if (!job || job.buyer_workspace_id !== workspaceId || job.listing_version_id !== row.tool_id || job.idempotency_key !== workflowStepHireKey(runId, s.index)) {
        throw new MarketError("POLICY_DENIED", `step ${s.index} job is not this step's hire`);
      }
      const receipt = (await db.admin.from("chain_receipts").select("signature, amount").eq("job_id", s.jobId).maybeSingle()).data as { signature: string; amount: string | number } | null;
      if (!receipt) throw new MarketError("SETTLEMENT_UNCERTAIN", `step ${s.index} has no verified receipt yet`);
      if (BigInt(String(receipt.amount)) > BigInt(String(row.max_base_units))) throw new MarketError("PRICE_CHANGED", `step ${s.index} paid more than its maximum`);
      out.push({ ...s, paidBaseUnits: String(receipt.amount), merchantSignatures: [receipt.signature] });
      continue;
    }
    const tool = (await db.admin.from("external_tools").select("pay_to, pay_to_ata, mint, unit_price_base_units, calls_per_step").eq("id", row.tool_id).single()).data as {
      pay_to: string;
      pay_to_ata: string;
      mint: string;
      unit_price_base_units: string | number;
      calls_per_step: number;
    };
    const sigs = [...new Set(s.merchantSignatures)];
    if (sigs.length === 0 || sigs.length !== s.merchantSignatures.length || sigs.length > tool.calls_per_step) throw new MarketError("INVALID_REQUEST", `step ${s.index} reports an invalid set of payments`);
    if (tool.mint !== config.mint) throw new MarketError("WRONG_MINT", "external tool mint differs from this marketplace");
    const reused = await db.admin.from("workflow_run_steps").select("run_id, step_index").overlaps("merchant_signatures", sigs);
    if ((reused.data ?? []).some((r: { run_id: string; step_index: number }) => r.run_id !== runId || r.step_index !== s.index)) {
      throw new MarketError("IDEMPOTENCY_CONFLICT", `step ${s.index} reuses a payment recorded for another step`);
    }
    if (row.payer === null || row.payer_bound_slot === null) throw new MarketError("POLICY_DENIED", `step ${s.index} has no bound payer`);
    const boundSlot = BigInt(String(row.payer_bound_slot));
    const unit = BigInt(String(tool.unit_price_base_units));
    for (const sig of sigs) {
      const outcome = checkTransfer(await chain.finalizedTransaction(sig), { signature: sig, mint: tool.mint, recipient: tool.pay_to, recipientAta: tool.pay_to_ata, amount: unit, sourceOwner: row.payer });
      if (outcome.status === "pending") throw new MarketError("SETTLEMENT_UNCERTAIN", `step ${s.index} payment is not finalized yet`);
      if (outcome.status === "invalid") throw new MarketError("SERVICE_NOT_ALLOWED", `step ${s.index} payment rejected: ${outcome.reason}`);
      if (outcome.transfer.slot <= boundSlot) throw new MarketError("SERVICE_NOT_ALLOWED", `step ${s.index} payment landed before its payer was bound`);
    }
    out.push({ ...s, paidBaseUnits: (unit * BigInt(sigs.length)).toString(), merchantSignatures: sigs });
  }
  return out;
}

/** Badge shown for a tool in the library: payment availability and provider configuration are separate facts. */
function toolBadge(status: string, providerStatus: string | null): "approved" | "in_review" | "provider_not_configured" | "manifest_changed" | "suspended" {
  if (providerStatus === "manifest_changed") return "manifest_changed";
  if (status === "suspended") return "suspended";
  if (status !== "published" && status !== "approved") return "in_review";
  if (providerStatus === "not_configured" || providerStatus === "unknown") return "provider_not_configured";
  return "approved";
}

export function registerWorkflowRoutes(app: Express, deps: Deps, h: WorkflowRouteHelpers): void {
  const { db, config } = deps;
  const { route } = h;

  // ---- public catalogue and tool library -----------------------------------------------------
  app.get(
    "/marketplace/workflows",
    route(async (req) => {
      const q = z
        .object({
          q: z.string().max(100).optional(),
          category: z.enum(WORKFLOW_CATEGORIES).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(60),
        })
        .parse(req.query);
      let query = db.anon().from("workflow_catalog").select("workflow_id, version_id, slug, creator_name, demo, category, title, summary, safety_promise, total_base_units, fee_bps, network, mint, decimals, steps, paid_runs, published_at").order("paid_runs", { ascending: false }).order("published_at", { ascending: false }).limit(q.limit);
      if (q.category) query = query.eq("category", q.category);
      if (q.q) query = query.textSearch("search", q.q, { type: "websearch", config: "english" });
      const { data, error } = await query;
      if (error) throw new MarketError("NOT_READY", "workflow catalogue unavailable");
      return { workflows: data ?? [] };
    }),
  );
  app.get(
    "/marketplace/workflows/:slug",
    route(async (req) => {
      const s = slug.parse(req.params.slug);
      const entry = must(await db.anon().from("workflow_catalog").select("*").eq("slug", s).maybeSingle(), "workflow not found") as { steps: Array<{ toolKind: string; toolId: string }> } & Record<string, unknown>;
      const listingSteps = entry.steps.filter((x) => x.toolKind === "listing").map((x) => x.toolId);
      const statuses = listingSteps.length === 0 ? [] : ((await db.anon().from("tool_profiles").select("listing_version_id, provider_status").in("listing_version_id", listingSteps)).data ?? []);
      const byId = new Map((statuses as Array<{ listing_version_id: string; provider_status: string }>).map((t) => [t.listing_version_id, t.provider_status]));
      return { workflow: { ...entry, search: undefined, steps: entry.steps.map((x) => ({ ...x, providerStatus: x.toolKind === "listing" ? (byId.get(x.toolId) ?? null) : null })) } };
    }),
  );
  app.get(
    "/marketplace/tools",
    route(async () => {
      const [listings, profiles, external] = await Promise.all([
        db.anon().from("catalog_entries").select("listing_id, listing_version_id, slug, seller_name, title, summary, runtime_kind, price_base_units, recipient, output_format, network, mint, decimals"),
        db.anon().from("tool_profiles").select("listing_version_id, tool_kind, provider, tool_name, effect, io, provider_status"),
        db.anon().from("external_tools").select("id, slug, title, summary, origin, resource_path, pay_to, unit_price_base_units, calls_per_step, io, status, network, mint, decimals"),
      ]);
      const prof = new Map(((profiles.data ?? []) as Array<Record<string, unknown> & { listing_version_id: string }>).map((p) => [p.listing_version_id, p]));
      const tools = [
        ...((listings.data ?? []) as Array<Record<string, unknown> & { listing_version_id: string; output_format: string; price_base_units: string | number }>).map((l) => {
          const p = prof.get(l.listing_version_id) as { tool_kind?: string; provider?: string | null; tool_name?: string | null; effect?: string; io?: ToolIo; provider_status?: string } | undefined;
          const providerStatus = p?.tool_kind === "provider_adapter" ? (p.provider_status ?? "unknown") : null;
          return {
            toolKind: "listing" as const,
            toolId: l.listing_version_id,
            slug: l.slug,
            title: l.title,
            summary: l.summary,
            by: l.seller_name,
            kind: p?.tool_kind ?? l.runtime_kind,
            provider: p?.provider ?? null,
            effect: p?.effect ?? "read_only",
            io: p?.io ?? defaultIo(l.output_format),
            priceBaseUnits: String(l.price_base_units),
            recipient: l.recipient,
            network: l.network,
            mint: l.mint,
            decimals: l.decimals,
            badge: toolBadge("published", providerStatus),
          };
        }),
        ...((external.data ?? []) as Array<Record<string, unknown> & { id: string; unit_price_base_units: string | number; calls_per_step: number; status: string }>).map((e) => ({
          toolKind: "external" as const,
          toolId: e.id,
          slug: e.slug,
          title: e.title,
          summary: e.summary,
          by: e.origin,
          kind: "external_x402",
          provider: null,
          effect: "read_only",
          io: e.io,
          priceBaseUnits: (BigInt(String(e.unit_price_base_units)) * BigInt(e.calls_per_step)).toString(),
          unitPriceBaseUnits: String(e.unit_price_base_units),
          callsPerStep: e.calls_per_step,
          recipient: e.pay_to,
          resourcePath: e.resource_path,
          network: e.network,
          mint: e.mint,
          decimals: e.decimals,
          badge: toolBadge(e.status, null),
        })),
      ];
      return { tools, providers: Object.values(PROVIDER_MANIFESTS).map((m) => ({ provider: m.provider, manifestSha256: toolManifestDigest(m), tools: m.tools })) };
    }),
  );

  // ---- creators -----------------------------------------------------------------------------
  app.post(
    "/creator/workflows",
    route(async (req) => {
      const actor = await h.user(req, true);
      await h.workspaceOf(actor);
      const body = z.object({ slug, category: z.enum(WORKFLOW_CATEGORIES) }).strict().parse(req.body);
      if (RESERVED_SLUGS.has(body.slug)) throw new MarketError("INVALID_REQUEST", "slug is reserved");
      return { workflowId: await db.rpc<string>("mk_create_workflow", { p_user: actor.userId, p_slug: body.slug, p_category: body.category, p_demo: false }) };
    }),
  );
  app.post(
    "/creator/workflows/:id/versions",
    route(async (req, res) => {
      const actor = await h.user(req, true);
      const v: WorkflowVersionInput = workflowVersionInputSchema.parse(req.body);
      const seller = (await db.admin.from("seller_profiles").select("id").eq("owner_user_id", actor.userId).maybeSingle()).data as { id: string } | null;
      const payout = seller
        ? ((await db.admin.from("seller_payout_versions").select("id, verified_at").eq("id", v.payoutVersionId).eq("seller_id", seller.id).maybeSingle()).data as { verified_at: string | null } | null)
        : null;
      const facts = await loadToolFacts(deps, v.steps);
      const check = checkWorkflowPublication(v, facts, payout !== null && payout.verified_at !== null);
      if (check.decision === "rejected") {
        res.status(400);
        return { error: { code: "INVALID_REQUEST", message: "workflow failed publication checks" }, problems: check.problems };
      }
      const r = await db.rpc<{ versionId: string; versionNo: number; decision: string }>("mk_create_workflow_version", {
        p_user: actor.userId,
        p_workflow: uuid.parse(req.params.id),
        v: { ...v, decimals: config.decimals },
      });
      return { ...r, checks: check };
    }),
  );
  app.post(
    "/creator/versions/:id/publish",
    route(async (req) => {
      const actor = await h.user(req, true);
      return { status: await db.rpc<string>("mk_publish_workflow_version", { p_user: actor.userId, p_version: uuid.parse(req.params.id) }) };
    }),
  );
  app.get(
    "/creator/workflows",
    route(async (req) => {
      const actor = await h.user(req);
      const c = db.asUser(actor.accessToken);
      const [workflows, versions] = await Promise.all([
        c.from("workflows").select("id, slug, category, status, current_version_id, demo, created_at, updated_at").order("created_at", { ascending: false }),
        c.from("workflow_versions").select("id, workflow_id, version_no, title, total_max_base_units, publish_decision, review_status, review_note, created_at").order("created_at", { ascending: false }),
      ]);
      return { workflows: workflows.data ?? [], versions: versions.data ?? [] };
    }),
  );
  app.post(
    "/seller/versions/:id/tool-profile",
    route(async (req) => {
      const actor = await h.user(req, true);
      const t = toolProfileSchema.parse(req.body);
      let manifestSha256: string | null = null;
      if (t.toolKind === "provider_adapter") {
        if (!t.provider || !t.toolName) throw new MarketError("INVALID_REQUEST", "a provider adapter names its provider and tool");
        const manifest = PROVIDER_MANIFESTS[t.provider];
        const tool = manifest.tools.find((x) => x.name === t.toolName);
        if (!tool) throw new MarketError("INVALID_REQUEST", "tool is not in the provider's pinned manifest");
        if (JSON.stringify(tool.io) !== JSON.stringify(t.io) || tool.effect !== t.effect) throw new MarketError("INVALID_REQUEST", "tool facts differ from the pinned manifest");
        manifestSha256 = toolManifestDigest(manifest);
      } else if (t.provider !== null || t.toolName !== null) {
        throw new MarketError("INVALID_REQUEST", "only provider adapters name a provider");
      }
      await db.rpc("mk_set_tool_profile", { p_user: actor.userId, p_version: uuid.parse(req.params.id), t: { ...t, manifestSha256 } });
      return { ok: true, manifestSha256 };
    }),
  );
  app.post(
    "/tools/external",
    route(async (req) => {
      const actor = await h.user(req, true);
      const t = externalToolSchema.parse(req.body);
      return { toolId: await db.rpc<string>("mk_propose_external_tool", { p_user: actor.userId, t: { ...t, network: config.network, mint: config.mint, decimals: config.decimals } }), status: "pending" };
    }),
  );

  // ---- owners: assignments and runs ---------------------------------------------------------
  app.post(
    "/me/assignments",
    route(async (req) => {
      const actor = await h.user(req, true);
      const b = z.object({ agentId: uuid, workflowId: uuid, budgetBaseUnits: baseUnits }).strict().parse(req.body);
      if (BigInt(b.budgetBaseUnits) <= 0n) throw new MarketError("INVALID_REQUEST", "budget must be positive");
      return { assignmentId: await db.rpc<string>("mk_assign_workflow", { p_user: actor.userId, p_agent: b.agentId, p_workflow: b.workflowId, p_budget: b.budgetBaseUnits }) };
    }),
  );
  app.post(
    "/me/assignments/:id/revoke",
    route(async (req) => {
      const actor = await h.user(req, true);
      await db.rpc("mk_revoke_assignment", { p_user: actor.userId, p_assignment: uuid.parse(req.params.id) });
      return { ok: true };
    }),
  );
  app.get(
    "/me/workflow-runs",
    route(async (req) => {
      const actor = await h.user(req);
      const c = db.asUser(actor.accessToken);
      const [runs, steps, assignments] = await Promise.all([
        c.from("workflow_runs").select("id, workflow_version_id, requested_by_agent_id, approval_digest, terms, is_test, status, stop_reason, created_at, updated_at").order("created_at", { ascending: false }).limit(50),
        c.from("workflow_run_steps").select("*"),
        c.from("workflow_assignments").select("id, agent_id, workflow_id, budget_base_units, status, created_at"),
      ]);
      return { runs: runs.data ?? [], steps: steps.data ?? [], assignments: assignments.data ?? [] };
    }),
  );

  // ---- controller (signed): runs are created and reported only by the local controller -------
  app.post(
    "/controller/workflow-runs",
    route(async (req) => {
      const ctl = await h.controller(req);
      const b = z
        .object({
          idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
          terms: workflowApprovalTermsSchema,
          approvalDigest: z.string().regex(/^[0-9a-f]{64}$/),
          localAgentId: z.string().max(128).nullable(),
          isTest: z.boolean(),
        })
        .strict()
        .parse(req.body);
      if (workflowApprovalDigest(b.terms) !== b.approvalDigest) throw new MarketError("PRICE_CHANGED", "approval digest does not match the terms");
      const problem = await toolDigestProblem(deps, b.terms);
      if (problem) throw new MarketError("PRICE_CHANGED", problem);
      if (b.terms.network !== config.network || b.terms.mint !== config.mint) throw new MarketError("WRONG_NETWORK", "terms name another network or mint");
      let agentId: string | null = null;
      if (b.localAgentId !== null) {
        const a = await db.admin.from("agents").select("id, status").eq("workspace_id", ctl.workspaceId).eq("local_agent_id", b.localAgentId).maybeSingle();
        if (!a.data || a.data.status !== "active") throw new MarketError("POLICY_DENIED", "agent is not active");
        agentId = a.data.id as string;
      }
      return db.rpc("mk_create_workflow_run", {
        p_workspace: ctl.workspaceId,
        p_version: b.terms.workflowVersionId,
        p_agent: agentId,
        p_idem: b.idempotencyKey,
        p_terms: b.terms,
        p_digest: b.approvalDigest,
        p_test: b.isTest,
      });
    }),
  );
  app.post(
    "/controller/workflow-runs/:id/report",
    route(async (req) => {
      const ctl = await h.controller(req);
      const b = runReportSchema.parse(req.body);
      const runId = uuid.parse(req.params.id);
      const steps = await verifiedSteps(deps, ctl.workspaceId, runId, b.steps);
      await db.rpc("mk_report_workflow_run", { p_workspace: ctl.workspaceId, p_run: runId, p_status: b.status, p_stop: b.stopReason, p_steps: steps });
      return { ok: true };
    }),
  );
  app.get(
    "/controller/workflow-versions/:id",
    route(async (req) => {
      const ctl = await h.controller(req);
      const v = must(await db.admin.from("workflow_versions").select("id, workflow_id, steps, run_inputs, total_max_base_units, network, mint, decimals, review_status").eq("id", uuid.parse(req.params.id)).maybeSingle(), "workflow version not found") as {
        id: string;
        workflow_id: string;
        steps: Array<{ toolKind: string; toolId: string; maxBaseUnits: string; inputs: unknown }>;
      } & Record<string, unknown>;
      const live = (await db.admin.from("workflow_catalog").select("version_id").eq("version_id", v.id).maybeSingle()).data !== null;
      const wf = (await db.admin.from("workflows").select("creator_user_id, status").eq("id", v.workflow_id).single()).data as { creator_user_id: string; status: string };
      const ws = (await db.admin.from("workspaces").select("owner_user_id").eq("id", ctl.workspaceId).single()).data as { owner_user_id: string };
      const creator = ws.owner_user_id === wf.creator_user_id;
      // Only live versions are visible to buyers; a creator's controller may load its own drafts to test them.
      if (!live && !creator) throw new MarketError("NOT_FOUND", "workflow version not found");
      if (wf.status === "suspended") throw new MarketError("POLICY_DENIED", "workflow is suspended");
      const facts = await loadToolFacts(deps, v.steps);
      const external = v.steps.filter((s) => s.toolKind === "external").map((s) => s.toolId);
      let extQuery = db.admin.from("external_tools").select("id, origin, resource_path, pay_to, pay_to_ata, unit_price_base_units, calls_per_step, fee_payers, rpc_methods, call_template, status");
      if (!creator) extQuery = extQuery.eq("status", "approved");
      const extRows = external.length === 0 ? [] : ((await extQuery.in("id", external)).data ?? []);
      const listingVersionIds = v.steps.filter((s) => s.toolKind === "listing").map((s) => s.toolId);
      const parents = listingVersionIds.length === 0 ? [] : ((await db.admin.from("listing_versions").select("id, listing_id").in("id", listingVersionIds)).data ?? []);
      const listingOf = new Map((parents as Array<{ id: string; listing_id: string }>).map((p) => [p.id, p.listing_id]));
      return {
        version: v,
        live,
        tools: v.steps.map((s) => {
          const f = facts.get(toolKey(s.toolKind as "listing" | "external", s.toolId));
          return f ? { ...f, priceBaseUnits: f.priceBaseUnits.toString(), listingId: s.toolKind === "listing" ? (listingOf.get(s.toolId) ?? null) : null } : null;
        }),
        externalTools: extRows,
      };
    }),
  );

  app.post(
    "/controller/workflow-runs/:id/steps/:index/payer",
    route(async (req) => {
      const ctl = await h.controller(req);
      const runId = uuid.parse(req.params.id);
      const index = z.coerce.number().int().min(0).max(7).parse(req.params.index);
      const b = z.object({ payer: address, payerProof: signatureB58 }).strict().parse(req.body);
      const run = (await db.admin.from("workflow_runs").select("approval_digest").eq("id", runId).eq("buyer_workspace_id", ctl.workspaceId).maybeSingle()).data as { approval_digest: string } | null;
      if (!run) throw new MarketError("NOT_FOUND", "workflow run not found");
      // The same proof the wallet gives for hires: the one-time payer signs this step's key and the run's approval digest.
      if (!(await verifyEd25519(b.payer, b.payerProof, payerBindingMessage(workflowStepHireKey(runId, index), run.approval_digest, b.payer)))) {
        throw new MarketError("FORBIDDEN", "payer proof is invalid");
      }
      // Transfers count only after this slot, so a payment made before the binding cannot be claimed.
      const boundSlot = (await deps.chain.finalizedSlot()).toString();
      await db.rpc("mk_bind_workflow_payer", { p_workspace: ctl.workspaceId, p_run: runId, p_index: index, p_payer: b.payer, p_bound_slot: boundSlot });
      return { ok: true };
    }),
  );
  app.get(
    "/controller/jobs/:id/deliverable",
    route(async (req) => {
      const ctl = await h.controller(req);
      const jobId = uuid.parse(req.params.id);
      const job = (await db.admin.from("jobs").select("id, state, buyer_workspace_id").eq("id", jobId).maybeSingle()).data as { state: string; buyer_workspace_id: string } | null;
      if (!job || job.buyer_workspace_id !== ctl.workspaceId) throw new MarketError("NOT_FOUND", "job not found");
      if (job.state !== "succeeded") return { state: job.state, artifacts: [] };
      const rows = ((await db.admin.from("artifacts").select("id, bucket, object_key, sha256, mime_type, bytes, validation_state").eq("job_id", jobId)).data ?? []) as Array<{
        id: string;
        bucket: string;
        object_key: string;
        sha256: string;
        mime_type: string;
        bytes: number;
        validation_state: string;
      }>;
      const artifacts = [];
      for (const a of rows.filter((r) => r.validation_state === "validated")) {
        const file = await db.admin.storage.from(a.bucket).download(a.object_key);
        if (file.error || !file.data) throw new MarketError("NOT_READY", "deliverable not readable yet");
        const bytes = Buffer.from(await file.data.arrayBuffer());
        // Stored bytes must still match the hash recorded when the seller delivered them.
        if (bytes.length !== a.bytes || createHash("sha256").update(bytes).digest("hex") !== a.sha256) throw new MarketError("SERVICE_NOT_ALLOWED", "deliverable failed its integrity check");
        artifacts.push({ artifactId: a.id, sha256: a.sha256, mimeType: a.mime_type, text: bytes.toString("utf8") });
      }
      return { state: job.state, artifacts };
    }),
  );

  // ---- seller host: manifest and provider status --------------------------------------------
  app.post(
    "/internal/seller-host/tool-status",
    route(async (req) => {
      const principal = await h.sellerHost(req);
      if (principal.kind !== "remote") throw new MarketError("FORBIDDEN", "only a seller's own host reports its providers");
      const b = z.object({ provider: z.enum(TOOL_PROVIDERS), manifestSha256: z.string().regex(/^[0-9a-f]{64}$/), configured: z.boolean() }).strict().parse(req.body);
      const disabled = await db.rpc<number>("mk_report_tool_status", { p_seller: principal.sellerId, p_provider: b.provider, p_manifest: b.manifestSha256, p_configured: b.configured });
      return { disabledTools: disabled };
    }),
  );

  // ---- operator -----------------------------------------------------------------------------
  app.get(
    "/operator/workflow-review-queue",
    route(async (req) => {
      h.operator(req);
      const [versions, tools] = await Promise.all([
        db.admin.from("workflow_versions").select("id, workflow_id, title, steps, total_max_base_units, created_at").eq("review_status", "pending"),
        db.admin.from("external_tools").select("id, slug, title, origin, resource_path, pay_to, unit_price_base_units, calls_per_step, status, created_at").eq("status", "pending"),
      ]);
      return { versions: versions.data ?? [], externalTools: tools.data ?? [] };
    }),
  );
  app.post(
    "/operator/workflow-versions/:id/review",
    route(async (req) => {
      h.operator(req);
      const b = z.object({ approve: z.boolean(), note: z.string().max(500).nullable() }).strict().parse(req.body);
      return { result: await db.rpc<string>("mk_review_workflow_version", { p_version: uuid.parse(req.params.id), p_approve: b.approve, p_note: b.note }) };
    }),
  );
  app.post(
    "/operator/workflows/:id/status",
    route(async (req) => {
      h.operator(req);
      const b = z.object({ status: z.enum(["suspended", "live"]) }).strict().parse(req.body);
      await db.rpc("mk_set_workflow_status", { p_workflow: uuid.parse(req.params.id), p_status: b.status });
      return { ok: true };
    }),
  );
  app.post(
    "/operator/external-tools/:id/status",
    route(async (req) => {
      h.operator(req);
      const b = z.object({ status: z.enum(["approved", "suspended"]), note: z.string().max(500).nullable() }).strict().parse(req.body);
      await db.rpc("mk_set_external_tool_status", { p_tool: uuid.parse(req.params.id), p_status: b.status, p_note: b.note });
      return { ok: true };
    }),
  );
}
