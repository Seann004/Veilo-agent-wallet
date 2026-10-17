import { randomBytes } from "node:crypto";
import {
  agentHireProposalSchema,
  completeRequestSchema,
  controllerDecisionSchema,
  controllerRegistrationMessage,
  controllerRegistrationSchema,
  controllerStatusSchema,
  failRequestSchema,
  inputRequestSchema,
  leaseRequestSchema,
  listingVersionInputSchema,
  MARKETPLACE_LIMITS,
  paymentEvidenceRequestSchema,
  payerBindingMessage,
  TEST_TOKEN_LABEL,
} from "@veilo/contracts/marketplace";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  authenticateController,
  authenticateUser,
  bearer,
  bearerMatches,
  RateLimiter,
  sha256Hex,
  verifyEd25519,
  type ControllerActor,
  type UserActor,
} from "./auth";
import { must } from "./db";
import { errorHandler, MarketError } from "./errors";
import { addPayout, completeJob, createHire, downloadLink, sellerOriginAllowed, submitEvidence, type Deps } from "./service";

type Handler = (req: Request & { rawBody?: Buffer }, res: Response) => Promise<unknown>;

function route(handler: Handler) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).then(
      (body) => {
        if (!res.headersSent) res.json(body ?? { ok: true });
      },
      (error: unknown) => next(error),
    );
  };
}

const uuid = z.uuid();
const signatureB58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/);
const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const baseUnits = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);

const hireSchema = z
  .object({ listingId: uuid, brief: z.string().trim().min(1).max(MARKETPLACE_LIMITS.maxBriefChars), idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/) })
  .strict();
const sellerProfileSchema = z.object({ publicName: z.string().trim().min(2).max(80), description: z.string().trim().max(2000).default("") }).strict();
const payoutSchema = z.object({ address, issuedAt: z.string().max(40), signature: signatureB58 }).strict();
const agentSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    purpose: z.string().trim().min(1).max(500),
    instructions: z.string().max(8000).default(""),
    template: z.string().regex(/^[a-z0-9-]{1,40}$/).default("generic"),
    tools: z.array(z.enum(["marketplace_search", "propose_hire", "web_read"])).max(8).default([]),
    discoveryEnabled: z.boolean().default(false),
    autoHireEnabled: z.boolean().default(false),
  })
  .strict();
const policySchema = z
  .object({
    perTaskCap: baseUnits,
    perAgentCap: baseUnits,
    maxPayment: baseUnits,
    periodHours: z.number().int().min(1).max(8760),
    allowedListingIds: z.array(uuid).max(50).default([]),
    allowedRecipients: z.array(address).max(50).default([]),
  })
  .strict()
  .refine((p) => BigInt(p.maxPayment) <= BigInt(p.perTaskCap) && BigInt(p.perTaskCap) <= BigInt(p.perAgentCap), "limits must nest: max payment ≤ per task ≤ per agent");

export function createApp(deps: Deps): Express {
  const { db, config } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (origin && config.allowedBrowserOrigins.includes(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "Origin");
      res.setHeader("access-control-allow-headers", "authorization, content-type");
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    }
    res.setHeader("cache-control", "no-store");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });
  app.use(
    express.json({
      limit: "2mb",
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }),
  );

  const limiter = new RateLimiter(120, 60_000);
  const writeLimiter = new RateLimiter(30, 60_000);
  const throttle = (key: string, write = false) => (write ? writeLimiter : limiter).check(key);

  const user = async (req: Request, write = false): Promise<UserActor> => {
    const actor = await authenticateUser(db, req);
    throttle(`u:${actor.userId}:${req.method}:${req.route?.path ?? req.path}`, write);
    return actor;
  };
  const workspaceOf = async (actor: UserActor): Promise<string> => {
    const r = await db.rpc<{ workspaceId: string }>("mk_bootstrap_user", { p_user: actor.userId, p_address: actor.address });
    return r.workspaceId;
  };
  const controller = (req: Request & { rawBody?: Buffer }): Promise<ControllerActor> =>
    authenticateController(
      req,
      async (keyId) => {
        const { data } = await db.admin.from("workspaces").select("id, controller_key, status").eq("controller_key_id", keyId).maybeSingle();
        return data && data.status === "active" && data.controller_key ? { workspaceId: data.id as string, controllerKey: data.controller_key as string } : null;
      },
      (keyId, nonce) => db.rpc<boolean>("mk_controller_nonce", { p_key_id: keyId, p_nonce: nonce }),
    );
  const operator = (req: Request): void => {
    if (!bearerMatches(req, config.operatorTokenHash)) throw new MarketError("UNAUTHENTICATED", "operator credential required");
  };
  type HostPrincipal = { kind: "managed" } | { kind: "remote"; sellerId: string };
  const sellerHost = async (req: Request): Promise<HostPrincipal> => {
    if (bearerMatches(req, config.sellerHostTokenHash)) return { kind: "managed" };
    const token = bearer(req);
    if (token) {
      const sellerId = await db.rpc<string | null>("mk_seller_for_host_credential", { p_token_hash: sha256Hex(token) });
      if (sellerId) return { kind: "remote", sellerId };
    }
    throw new MarketError("UNAUTHENTICATED", "seller host credential required");
  };
  /** A seller host may act only on jobs of its own runtime kind and, for remote hosts, its own seller. */
  const hostJob = async (req: Request, jobId: string) => {
    const principal = await sellerHost(req);
    const view = await db.rpc<{ runtime: { kind: string }; quote: { sellerIdentity: string } } & Record<string, unknown>>("mk_seller_host_job", { p_job: jobId });
    const job = must(await db.admin.from("jobs").select("seller_id").eq("id", jobId).single()) as { seller_id: string };
    const allowed = principal.kind === "managed" ? view.runtime.kind === "managed_template" : view.runtime.kind === "remote_endpoint" && job.seller_id === principal.sellerId;
    if (!allowed) throw new MarketError("NOT_FOUND", "job not found");
    return view;
  };

  app.get("/health", (_req, res) => {
    res.json({ service: "marketplace", network: config.network, mint: config.mint, managedSellerHost: config.managedSellerOrigin !== null, label: TEST_TOKEN_LABEL });
  });

  // ---- public catalogue (anonymous, sanitized projection) ----------------------------------
  app.get(
    "/marketplace/listings",
    route(async (req) => {
      throttle(`ip:${req.ip}:catalog`);
      const q = z.object({ q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(50).default(20), offset: z.coerce.number().int().min(0).max(10_000).default(0) }).parse(req.query);
      let query = db.anon().from("catalog_entries").select("*").order("published_at", { ascending: false }).range(q.offset, q.offset + q.limit - 1);
      if (q.q) query = query.textSearch("search", q.q, { type: "websearch", config: "english" });
      const { data, error } = await query;
      if (error) throw new MarketError("PROVIDER_UNAVAILABLE", "catalogue unavailable");
      return { listings: (data ?? []).map(({ search: _s, ...rest }) => rest), label: TEST_TOKEN_LABEL };
    }),
  );
  app.get(
    "/marketplace/listings/:slug",
    route(async (req) => {
      const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/).parse(req.params.slug);
      const entry = must(await db.anon().from("catalog_entries").select("*").eq("slug", slug).maybeSingle(), "listing not found") as Record<string, unknown>;
      const { data: samples } = await db.anon().from("listing_samples").select("id, title, content").eq("listing_version_id", entry.listing_version_id as string);
      delete entry.search;
      return { listing: entry, samples: samples ?? [], label: TEST_TOKEN_LABEL };
    }),
  );

  // ---- signed-in account ------------------------------------------------------------------
  app.post(
    "/me/bootstrap",
    route(async (req) => {
      const actor = await user(req, true);
      return { workspaceId: await workspaceOf(actor), address: actor.address, userId: actor.userId };
    }),
  );
  app.get(
    "/me",
    route(async (req) => {
      const actor = await user(req);
      const c = db.asUser(actor.accessToken);
      const [ws, links, seller] = await Promise.all([
        c.from("workspaces").select("id, status, controller_key, controller_key_id, controller_registered_at, controller_last_seen_at").maybeSingle(),
        c.from("wallet_links").select("address, chain, verified_at"),
        c.from("seller_profiles").select("id, public_name, description, status").maybeSingle(),
      ]);
      return { userId: actor.userId, address: actor.address, workspace: ws.data, wallets: links.data ?? [], seller: seller.data };
    }),
  );
  app.post(
    "/me/controller",
    route(async (req) => {
      const actor = await user(req, true);
      const body = controllerRegistrationSchema.parse(req.body);
      const workspaceId = await workspaceOf(actor);
      const message = controllerRegistrationMessage(workspaceId, actor.userId, body.controllerKey, body.keyId);
      if (!(await verifyEd25519(body.controllerKey, body.proof, message))) throw new MarketError("FORBIDDEN", "controller proof is invalid");
      await db.rpc("mk_register_controller", { p_user: actor.userId, p_key: body.controllerKey, p_key_id: body.keyId });
      return { workspaceId, keyId: body.keyId };
    }),
  );

  // ---- owner agents (proposals; the local controller is authoritative) ---------------------
  app.post(
    "/agents",
    route(async (req) => {
      const actor = await user(req, true);
      await workspaceOf(actor);
      return { agentId: await db.rpc<string>("mk_create_agent", { p_user: actor.userId, a: agentSchema.parse(req.body) }) };
    }),
  );
  app.post(
    "/agents/:id/policy-proposals",
    route(async (req) => {
      const actor = await user(req, true);
      const version = await db.rpc<number>("mk_propose_policy", { p_user: actor.userId, p_agent: uuid.parse(req.params.id), p: policySchema.parse(req.body) });
      return { version, status: "proposed", note: "inactive until your local controller acknowledges this policy" };
    }),
  );
  app.post(
    "/agents/:id/status",
    route(async (req) => {
      const actor = await user(req, true);
      const { status } = z.object({ status: z.enum(["paused", "revoked", "archived"]) }).strict().parse(req.body);
      await db.rpc("mk_set_agent_status", { p_user: actor.userId, p_agent: uuid.parse(req.params.id), p_status: status });
      return { status };
    }),
  );

  // ---- buyer jobs ---------------------------------------------------------------------------
  app.post(
    "/jobs",
    route(async (req) => {
      const actor = await user(req, true);
      const body = hireSchema.parse(req.body);
      const workspaceId = await workspaceOf(actor);
      return createHire(deps, { workspaceId, listingId: body.listingId, brief: body.brief, idempotencyKey: body.idempotencyKey, agentId: null });
    }),
  );
  app.get(
    "/jobs",
    route(async (req) => {
      const actor = await user(req);
      const { data, error } = await db.asUser(actor.accessToken).from("jobs").select("*").order("created_at", { ascending: false }).limit(100);
      if (error) throw new MarketError("PROVIDER_UNAVAILABLE", "jobs unavailable");
      return { jobs: data ?? [] };
    }),
  );
  app.get(
    "/jobs/:id",
    route(async (req) => {
      const actor = await user(req);
      const id = uuid.parse(req.params.id);
      const c = db.asUser(actor.accessToken);
      const job = must(await c.from("jobs").select("*").eq("id", id).maybeSingle(), "job not found");
      const [quote, inputs, events, artifacts, receipt, refunds, payment] = await Promise.all([
        c.from("quotes").select("*").eq("job_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
        c.from("job_inputs").select("id, kind, body, created_by, created_at").eq("job_id", id).order("created_at"),
        c.from("job_events").select("seq, kind, from_state, to_state, actor_type, payload, created_at").eq("job_id", id).order("seq"),
        c.from("artifacts").select("id, sha256, mime_type, bytes, validation_state, version, created_at").eq("job_id", id),
        c.from("chain_receipts").select("signature, amount, mint, network, finalized_slot, verified_at").eq("job_id", id).maybeSingle(),
        c.from("refund_requests").select("id, amount, status, reason, refund_signature, created_at").eq("job_id", id),
        c.from("payment_operations").select("status, reject_code, updated_at").eq("job_id", id).maybeSingle(),
      ]);
      return {
        job,
        quote: quote.data,
        inputs: inputs.data ?? [],
        events: events.data ?? [],
        artifacts: artifacts.data ?? [],
        receipt: receipt.data,
        refunds: refunds.data ?? [],
        payment: payment.data,
        label: TEST_TOKEN_LABEL,
      };
    }),
  );
  app.post(
    "/jobs/:id/approve",
    route(async (req) => {
      const actor = await user(req, true);
      await db.rpc("mk_owner_approve", { p_user: actor.userId, p_job: uuid.parse(req.params.id) });
      return { state: "awaiting_payment", note: "your local controller must still authorize and pay this quote" };
    }),
  );
  app.post(
    "/jobs/:id/inputs",
    route(async (req) => {
      const actor = await user(req, true);
      const { body } = z.object({ body: z.string().trim().min(1).max(MARKETPLACE_LIMITS.maxBriefChars) }).strict().parse(req.body);
      await db.rpc("mk_respond_input", { p_user: actor.userId, p_job: uuid.parse(req.params.id), p_body: body });
      return { state: "queued" };
    }),
  );
  app.post(
    "/jobs/:id/cancel",
    route(async (req) => {
      const actor = await user(req, true);
      return { state: await db.rpc<string>("mk_cancel", { p_user: actor.userId, p_job: uuid.parse(req.params.id) }) };
    }),
  );
  app.post(
    "/jobs/:id/refund-requests",
    route(async (req) => {
      const actor = await user(req, true);
      const body = z.object({ amount: baseUnits, returnAddress: address, reason: z.string().trim().min(1).max(2000) }).strict().parse(req.body);
      if (BigInt(body.amount) <= 0n) throw new MarketError("INVALID_REQUEST", "refund amount must be positive");
      const refundId = await db.rpc<string>("mk_request_refund", {
        p_user: actor.userId,
        p_job: uuid.parse(req.params.id),
        p_amount: body.amount,
        p_return: body.returnAddress,
        p_reason: body.reason,
      });
      return { refundId, note: "refunds are seller-funded transfers; Veilo cannot reverse a direct payment" };
    }),
  );
  app.post(
    "/payments/:operationId/evidence",
    route(async (req, res) => {
      const actor = await user(req, true);
      const { signature } = z.object({ signature: signatureB58 }).strict().parse(req.body);
      const operationId = z.string().max(128).parse(req.params.operationId);
      const workspaceId = await workspaceOf(actor);
      const own = await db.admin.from("jobs").select("id").eq("operation_id", operationId).eq("buyer_workspace_id", workspaceId).maybeSingle();
      if (!own.data) throw new MarketError("NOT_FOUND", "operation not found");
      const r = await submitEvidence(deps, operationId, signature);
      if (r.status === "pending") res.status(202);
      return r;
    }),
  );
  app.post(
    "/artifacts/:id/download",
    route(async (req) => {
      const actor = await user(req, true);
      return downloadLink(deps, actor.accessToken, uuid.parse(req.params.id));
    }),
  );

  // ---- seller -------------------------------------------------------------------------------
  app.post(
    "/seller/profile",
    route(async (req) => {
      const actor = await user(req, true);
      await workspaceOf(actor);
      const body = sellerProfileSchema.parse(req.body);
      return { sellerId: await db.rpc<string>("mk_upsert_seller", { p_user: actor.userId, p_name: body.publicName, p_description: body.description }) };
    }),
  );
  app.post(
    "/seller/payouts",
    route(async (req) => {
      const actor = await user(req, true);
      return { payoutVersionId: await addPayout(deps, actor.userId, payoutSchema.parse(req.body)) };
    }),
  );
  app.post(
    "/seller/listings",
    route(async (req) => {
      const actor = await user(req, true);
      const { slug } = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/) }).strict().parse(req.body);
      // These names are dashboard routes under /marketplace; a listing must not shadow them.
      if (["jobs", "seller", "agents", "approvals"].includes(slug)) throw new MarketError("INVALID_REQUEST", "slug is reserved");
      return { listingId: await db.rpc<string>("mk_create_listing", { p_user: actor.userId, p_slug: slug }) };
    }),
  );
  app.post(
    "/seller/listings/:id/versions",
    route(async (req) => {
      const actor = await user(req, true);
      const v = listingVersionInputSchema.parse(req.body);
      if (v.remoteOrigin !== null && !sellerOriginAllowed(config, v.remoteOrigin)) throw new MarketError("SERVICE_NOT_ALLOWED", "remote origin must be a public https origin");
      const runtimeVersionId = v.runtimeKind === "managed_template" ? `managed:${v.template}:v1` : "remote:seller-protocol:v1";
      const versionId = await db.rpc<string>("mk_create_listing_version", {
        p_user: actor.userId,
        p_listing: uuid.parse(req.params.id),
        v: { ...v, runtimeVersionId, network: config.network, mint: config.mint, decimals: config.decimals },
        p_seller_instructions: v.sellerInstructions,
      });
      return { versionId, reviewStatus: "pending" };
    }),
  );
  app.post(
    "/seller/versions/:id/submit",
    route(async (req) => {
      const actor = await user(req, true);
      await db.rpc("mk_submit_review", { p_user: actor.userId, p_version: uuid.parse(req.params.id) });
      return { status: "in_review" };
    }),
  );
  app.get(
    "/seller/dashboard",
    route(async (req) => {
      const actor = await user(req);
      const c = db.asUser(actor.accessToken);
      const [seller, listings, versions, payouts, jobs, earnings] = await Promise.all([
        c.from("seller_profiles").select("*").maybeSingle(),
        c.from("listings").select("*").order("created_at", { ascending: false }),
        c.from("listing_versions").select("id, listing_id, version_no, title, price_base_units, runtime_kind, template, review_status, review_note, created_at").order("created_at", { ascending: false }),
        c.from("seller_payout_versions").select("id, address, ata, network, mint, verified_at").order("created_at", { ascending: false }),
        c.from("jobs").select("id, state, financial_state, listing_version_id, created_at, updated_at").order("created_at", { ascending: false }).limit(100),
        c.from("earnings_events").select("event_type, gross, fee, refund, network, mint, created_at, job_id").order("created_at", { ascending: false }),
      ]);
      const totals = new Map<string, { gross: bigint; fee: bigint; refunded: bigint }>();
      for (const e of (earnings.data ?? []) as Array<{ gross: string | number; fee: string | number; refund: string | number; network: string; mint: string }>) {
        const k = `${e.network}|${e.mint}`;
        const t = totals.get(k) ?? { gross: 0n, fee: 0n, refunded: 0n };
        t.gross += BigInt(String(e.gross));
        t.fee += BigInt(String(e.fee));
        t.refunded += BigInt(String(e.refund));
        totals.set(k, t);
      }
      return {
        seller: seller.data,
        listings: listings.data ?? [],
        versions: versions.data ?? [],
        payouts: payouts.data ?? [],
        jobs: jobs.data ?? [],
        earnings: earnings.data ?? [],
        totals: [...totals].map(([k, t]) => {
          const [network, mint] = k.split("|");
          return { network, mint, gross: t.gross.toString(), platformFee: t.fee.toString(), refunded: t.refunded.toString(), net: (t.gross - t.fee - t.refunded).toString() };
        }),
        note: "Payments settle directly to your payout wallet; Veilo holds no withdrawable balance.",
        label: TEST_TOKEN_LABEL,
      };
    }),
  );
  app.post(
    "/refunds/:id/decision",
    route(async (req) => {
      const actor = await user(req, true);
      const { approve } = z.object({ approve: z.boolean() }).strict().parse(req.body);
      await db.rpc("mk_refund_decision", { p_user: actor.userId, p_refund: uuid.parse(req.params.id), p_approve: approve });
      return { status: approve ? "approved" : "declined" };
    }),
  );
  app.post(
    "/refunds/:id/submitted",
    route(async (req, res) => {
      const actor = await user(req, true);
      const refundId = uuid.parse(req.params.id);
      const { signature } = z.object({ signature: signatureB58 }).strict().parse(req.body);
      await db.rpc("mk_refund_submitted", { p_user: actor.userId, p_refund: refundId, p_signature: signature });
      const outcome = await verifyRefund(refundId, signature);
      if (outcome === "pending") res.status(202);
      return { status: outcome === "pending" ? "submitted" : "finalized" };
    }),
  );

  /** A refund counts only when the exact amount reached the buyer-verified return address. */
  async function verifyRefund(refundId: string, signature: string): Promise<"pending" | "finalized"> {
    const rr = must(await db.admin.from("refund_requests").select("amount, return_address, receipt_id").eq("id", refundId).single()) as {
      amount: string | number;
      return_address: string;
      receipt_id: string;
    };
    const receipt = must(await db.admin.from("chain_receipts").select("mint, job_id").eq("id", rr.receipt_id).single()) as { mint: string; job_id: string };
    const quote = must(await db.admin.from("quotes").select("recipient").eq("job_id", receipt.job_id).order("created_at", { ascending: false }).limit(1).single()) as {
      recipient: string;
    };
    const { checkTransfer, deriveAta } = await import("./chain");
    const ata = await deriveAta(rr.return_address, receipt.mint);
    const outcome = checkTransfer(await deps.chain.finalizedTransaction(signature), {
      signature,
      mint: receipt.mint,
      recipient: rr.return_address,
      recipientAta: ata,
      amount: BigInt(String(rr.amount)),
      sourceOwner: quote.recipient,
    });
    if (outcome.status === "pending") return "pending";
    if (outcome.status === "invalid") throw new MarketError("SERVICE_NOT_ALLOWED", `refund evidence rejected: ${outcome.reason}`);
    await db.rpc("mk_record_refund", { p_refund: refundId, p_signature: signature });
    return "finalized";
  }

  // ---- operator review ----------------------------------------------------------------------
  app.get(
    "/operator/review-queue",
    route(async (req) => {
      operator(req);
      const [versions, sellers] = await Promise.all([
        db.admin.from("listing_versions").select("id, listing_id, seller_id, version_no, title, summary, runtime_kind, template, remote_origin, price_base_units, created_at").eq("review_status", "pending"),
        db.admin.from("seller_profiles").select("id, public_name, description, status, created_at").eq("status", "pending"),
      ]);
      return { versions: versions.data ?? [], sellers: sellers.data ?? [] };
    }),
  );
  app.post(
    "/operator/sellers/:id/status",
    route(async (req) => {
      operator(req);
      const { status } = z.object({ status: z.enum(["approved", "suspended"]) }).strict().parse(req.body);
      const sellerId = uuid.parse(req.params.id);
      await db.rpc("mk_set_seller_status", { p_seller: sellerId, p_status: status });
      if (status === "suspended") await db.rpc("mk_revoke_seller_host_credential", { p_seller: sellerId });
      return { status };
    }),
  );
  app.post(
    "/operator/sellers/:id/host-credential",
    route(async (req) => {
      operator(req);
      const token = `vsh_${randomBytes(32).toString("base64url")}`;
      await db.rpc("mk_issue_seller_host_credential", { p_seller: uuid.parse(req.params.id), p_token_hash: sha256Hex(token) });
      return { token, note: "shown once; give it only to this seller's host" };
    }),
  );
  app.post(
    "/operator/versions/:id/review",
    route(async (req) => {
      operator(req);
      const { approve, note } = z.object({ approve: z.boolean(), note: z.string().max(500).nullable().default(null) }).strict().parse(req.body);
      await db.rpc("mk_review_version", { p_version: uuid.parse(req.params.id), p_approve: approve, p_note: note });
      return { reviewStatus: approve ? "approved" : "rejected" };
    }),
  );
  app.post(
    "/operator/listings/:id/status",
    route(async (req) => {
      operator(req);
      const { status } = z.object({ status: z.enum(["suspended", "archived"]) }).strict().parse(req.body);
      await db.rpc("mk_set_listing_status", { p_listing: uuid.parse(req.params.id), p_status: status });
      return { status };
    }),
  );
  app.post(
    "/operator/sweep",
    route(async (req) => {
      operator(req);
      return { expired: await db.rpc<number>("mk_expire_sweep", {}) };
    }),
  );

  // ---- local controller (signed requests) ----------------------------------------------------
  app.get(
    "/controller/payment-requests",
    route(async (req) => {
      const ctl = await controller(req);
      return { requests: await db.rpc<unknown[]>("mk_controller_requests", { p_workspace: ctl.workspaceId }) };
    }),
  );
  app.post(
    "/controller/payment-requests/:operationId/decision",
    route(async (req) => {
      const ctl = await controller(req);
      const body = controllerDecisionSchema.parse(req.body);
      await db.rpc("mk_controller_decision", {
        p_workspace: ctl.workspaceId,
        p_operation: z.string().max(128).parse(req.params.operationId),
        p_accept: body.decision === "accepted",
        p_code: body.code,
        p_ref: body.controllerRef,
      });
      return { decision: body.decision };
    }),
  );
  app.post(
    "/controller/payment-requests/:operationId/status",
    route(async (req) => {
      const ctl = await controller(req);
      const body = controllerStatusSchema.parse(req.body);
      const operationId = z.string().max(128).parse(req.params.operationId);
      let boundSlot: string | null = null;
      if (body.payer !== null) {
        const q = await db.admin.from("payment_operations").select("quote_id, quotes(quote_digest)").eq("operation_id", operationId).maybeSingle();
        const digest = (q.data?.quotes as { quote_digest?: string } | null)?.quote_digest;
        if (!digest) throw new MarketError("NOT_FOUND", "operation not found");
        if (!(await verifyEd25519(body.payer, body.payerProof ?? "", payerBindingMessage(operationId, digest, body.payer)))) {
          throw new MarketError("FORBIDDEN", "payer binding proof is invalid");
        }
        boundSlot = (await deps.chain.finalizedSlot()).toString();
      }
      await db.rpc("mk_controller_status", {
        p_workspace: ctl.workspaceId,
        p_operation: operationId,
        p_status: body.status,
        p_detail: body.detail,
        p_payer: body.payer,
        p_bound_slot: boundSlot,
      });
      return { status: body.status };
    }),
  );
  app.post(
    "/controller/payments/:operationId/evidence",
    route(async (req, res) => {
      const ctl = await controller(req);
      const body = paymentEvidenceRequestSchema.parse(req.body);
      const operationId = z.string().max(128).parse(req.params.operationId);
      if (body.operationId !== operationId) throw new MarketError("INVALID_REQUEST", "operation mismatch");
      const own = await db.admin.from("jobs").select("id").eq("operation_id", operationId).eq("buyer_workspace_id", ctl.workspaceId).maybeSingle();
      if (!own.data) throw new MarketError("NOT_FOUND", "operation not found");
      const r = await submitEvidence(deps, operationId, body.signature);
      if (r.status === "pending") res.status(202);
      return r;
    }),
  );
  app.post(
    "/controller/hires",
    route(async (req) => {
      const ctl = await controller(req);
      const body = agentHireProposalSchema.parse(req.body);
      const agent = await db.admin.from("agents").select("id, status").eq("workspace_id", ctl.workspaceId).eq("local_agent_id", body.localAgentId).maybeSingle();
      if (agent.data && agent.data.status !== "active") throw new MarketError("POLICY_DENIED", "agent is not active");
      const hire = await createHire(deps, {
        workspaceId: ctl.workspaceId,
        listingId: body.listingId,
        brief: body.brief,
        idempotencyKey: body.idempotencyKey,
        agentId: (agent.data?.id as string | undefined) ?? null,
      });
      await db.rpc("mk_controller_open_payment", { p_workspace: ctl.workspaceId, p_job: hire.jobId, p_local_agent: body.localAgentId });
      return { jobId: hire.jobId, operationId: hire.quote.operationId, quote: hire.quote, existing: hire.existing };
    }),
  );
  app.get(
    "/controller/policy-proposals",
    route(async (req) => {
      const ctl = await controller(req);
      const { data } = await db.admin
        .from("agent_policy_proposals")
        .select("agent_id, version, per_task_cap, per_agent_cap, max_payment, period_hours, allowed_listing_ids, allowed_recipients, created_at, agents(name, purpose, instructions, template, tools, discovery_enabled, auto_hire_enabled, local_agent_id)")
        .eq("workspace_id", ctl.workspaceId)
        .eq("status", "proposed");
      return { proposals: data ?? [] };
    }),
  );
  app.post(
    "/controller/policy-proposals/ack",
    route(async (req) => {
      const ctl = await controller(req);
      const body = z
        .object({ agentId: uuid, version: z.number().int().min(1), accept: z.boolean(), localPolicyVersion: z.number().int().min(0).nullable(), localAgentId: z.string().max(128).nullable() })
        .strict()
        .parse(req.body);
      await db.rpc("mk_ack_policy", {
        p_workspace: ctl.workspaceId,
        p_agent: body.agentId,
        p_version: body.version,
        p_accept: body.accept,
        p_local_version: body.localPolicyVersion,
        p_local_agent: body.localAgentId,
      });
      return { status: body.accept ? "acknowledged" : "rejected" };
    }),
  );

  // ---- seller host (managed or remote, scoped) ------------------------------------------------
  app.get(
    "/internal/seller-host/jobs/:jobId",
    route(async (req) => hostJob(req, uuid.parse(req.params.jobId))),
  );
  app.post(
    "/internal/seller-host/jobs/:jobId/payment-evidence",
    route(async (req, res) => {
      const jobId = uuid.parse(req.params.jobId);
      await hostJob(req, jobId);
      const body = paymentEvidenceRequestSchema.parse(req.body);
      const r = await submitEvidence(deps, body.operationId, body.signature, jobId);
      if (r.status === "pending") res.status(202);
      return r;
    }),
  );
  app.post(
    "/internal/seller-host/jobs/:jobId/claim",
    route(async (req) => {
      const jobId = uuid.parse(req.params.jobId);
      await hostJob(req, jobId);
      const leaseToken = randomBytes(32).toString("base64url");
      const r = await db.rpc<{ attemptId: string; leaseGeneration: number; leaseExpiresAt: string }>("mk_claim", {
        p_job: jobId,
        p_worker: (await sellerHost(req)).kind,
        p_token_hash: sha256Hex(leaseToken),
        p_lease_seconds: MARKETPLACE_LIMITS.leaseSeconds,
      });
      return { attemptId: r.attemptId, leaseGeneration: r.leaseGeneration, leaseToken, leaseExpiresAt: r.leaseExpiresAt };
    }),
  );
  app.post(
    "/internal/seller-host/jobs/:jobId/heartbeat",
    route(async (req) => {
      const jobId = uuid.parse(req.params.jobId);
      await hostJob(req, jobId);
      const body = leaseRequestSchema.parse(req.body);
      const expires = await db.rpc<string>("mk_heartbeat", { p_job: jobId, p_attempt: body.attemptId, p_token_hash: sha256Hex(body.leaseToken), p_lease_seconds: MARKETPLACE_LIMITS.leaseSeconds });
      return { leaseExpiresAt: expires };
    }),
  );
  app.post(
    "/internal/seller-host/jobs/:jobId/complete",
    route(async (req) => {
      const jobId = uuid.parse(req.params.jobId);
      await hostJob(req, jobId);
      await completeJob(deps, jobId, completeRequestSchema.parse(req.body));
      return { state: "succeeded" };
    }),
  );
  app.post(
    "/internal/seller-host/jobs/:jobId/fail",
    route(async (req) => {
      const jobId = uuid.parse(req.params.jobId);
      await hostJob(req, jobId);
      const body = failRequestSchema.parse(req.body);
      await db.rpc("mk_fail", { p_job: jobId, p_attempt: body.attemptId, p_token_hash: sha256Hex(body.leaseToken), p_code: body.code, p_uncertain: body.uncertain });
      return { state: body.uncertain ? "delivery_uncertain" : "failed" };
    }),
  );
  app.post(
    "/internal/seller-host/jobs/:jobId/input-request",
    route(async (req) => {
      const jobId = uuid.parse(req.params.jobId);
      await hostJob(req, jobId);
      const body = inputRequestSchema.parse(req.body);
      await db.rpc("mk_request_input", {
        p_job: jobId,
        p_attempt: body.attemptId,
        p_token_hash: sha256Hex(body.leaseToken),
        p_question: body.question,
        p_window_seconds: MARKETPLACE_LIMITS.inputResponseWindowSeconds,
      });
      return { state: "input_required" };
    }),
  );

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "route not found" } });
  });
  app.use(errorHandler);
  return app;
}
