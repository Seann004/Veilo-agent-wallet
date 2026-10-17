import { Router, type Request, type Response } from "express";
import type { z } from "zod";
import {
  activityQuerySchema,
  agentConfigPatchSchema,
  calendarSchema,
  campaignBriefSchema,
  researchTaskInputSchema,
  createAgentRequestSchema,
  purchaseDecisionRequestSchema,
  purchaseIntentRequestSchema,
  reconcileRequestSchema,
  runAgentRequestSchema,
  saveArtifactRequestSchema,
  handoffRequestSchema,
  sessionChallengeRequestSchema,
  sessionVerifyRequestSchema,
  workspacePolicyRequestSchema,
  workspaceStopRequestSchema,
} from "@veilo/contracts";
import { immediate } from "@veilo/db";
import { big, iso, num, type Ledger } from "../context";
import { ControlError } from "../errors";
import { issueWorkerCredential } from "../auth/credentials";
import {
  DEFAULT_GUEST_RUNS_PER_HOUR,
  SESSION_COOKIE,
  authenticateSession,
  clearedSessionCookie,
  createChallenge,
  revokeSession,
  sessionCookie,
  verifyChallenge,
} from "../auth/session";
import { authorizePurchase } from "../ledger/authorize";
import { emergencyStop, pauseAgent, resumeAgent, resumeWorkspace, revokeAgent } from "../ledger/authority";
import { writeAudit } from "../ledger/events";
import { enqueueJob, jobView } from "../ledger/jobs";
import { decidePurchase, getPurchaseRow, purchaseView, type PurchaseRow } from "../ledger/purchases";
import { activity, agentBudget, createTask, requestHandoff, saveArtifact } from "../ledger/summaries";
import { chargeToolCall, getTask, validateResearchCitations } from "../agents/work";
import type { Integration } from "../integration";
import { fullBalances } from "../integration/balances";
import { RETRY_MARKER } from "../scheduler/scheduler";
import {
  activatePolicyVersion,
  activeAgentPolicy,
  agentPermissions,
  insertAgent,
  insertAgentPolicyDraft,
  insertWorkspacePolicyDraft,
  listAgents,
  listPolicies,
  policyView,
  requireAgent,
  requireWorkspace,
  type AgentRow,
} from "../ledger/workspace";
import { READERS, actorOf, assertOrigin, readCookie, requireActor, type Actor, type AuthDeps } from "./actor";
import { isViewer, redactActivityEvents, redactBalances, redactPurchase } from "./redact";

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    // Paths and messages only; submitted values are never echoed.
    const details = r.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; ");
    throw new ControlError("INVALID_REQUEST", details);
  }
  return r.data;
}

const param = (req: Request, name: string): string => {
  const v = req.params[name];
  if (typeof v !== "string" || !/^[0-9a-f-]{36}$/.test(v)) throw new ControlError("NOT_FOUND", "resource not found");
  return v;
};

function agentView(ledger: Ledger, a: AgentRow): Record<string, unknown> {
  const policy = activeAgentPolicy(ledger, a.id);
  return {
    id: a.id,
    name: a.name,
    role: a.role,
    status: a.status,
    description: a.description,
    trigger: JSON.parse(a.trigger_json) as unknown,
    modelProfile: a.model_profile,
    policyVersion: num(a.policy_version),
    activePolicy: policy ? policyView(policy) : null,
    revocationEpoch: num(a.revocation_epoch),
    updatedAt: iso(a.updated_at_ms),
  };
}

export const TASK_HEADER = "x-veilo-task-id";

/** Counts a worker tool call against its running task, identified by body or header. */
function chargeWorkerCall(ledger: Ledger, req: Request, agentId: string, taskId: string | undefined, tool: string): void {
  const header = req.headers[TASK_HEADER];
  const id = taskId ?? (typeof header === "string" ? header : undefined);
  if (id === undefined) return;
  const task = getTask(ledger, id);
  if (taskId === undefined || task?.state === "running") chargeToolCall(ledger, agentId, id, tool);
}

const HOUR_MS = 3_600_000;

type GuestActor = Extract<Actor, { kind: "guest" }>;

const guestRunsInLastHour = (ledger: Ledger, guest: GuestActor): number =>
  num(
    ledger.db
      .prepare(
        `SELECT count(*) FROM audit_event WHERE workspace_id = ? AND actor_type = 'system' AND actor_id = ? AND action = 'agent.run'
           AND policy_result = 'allowed' AND created_at_ms > ?`,
      )
      .pluck()
      .get(guest.workspaceId, guest.guestPubkey, ledger.now() - HOUR_MS),
  );

function denyGuestRun(ledger: Ledger, guest: GuestActor, agentId: string, reason: string): never {
  immediate(ledger.db, () =>
    writeAudit(ledger, {
      workspaceId: guest.workspaceId,
      scope: `agent:${agentId}`,
      actorType: "system",
      actorId: guest.guestPubkey,
      action: "agent.run",
      policyResult: "denied",
      reasonCode: "POLICY_DENIED",
      details: { actor: "guest", reason },
    }),
  );
  throw new ControlError("POLICY_DENIED", reason);
}

export function controlRouter(deps: AuthDeps & { integration?: Integration | undefined }): Router {
  const { ledger } = deps;
  const integration = deps.integration;
  const r = Router();
  const owner = requireActor(deps, ["owner"]);
  const worker = requireActor(deps, ["worker"]);
  const ownerOrService = requireActor(deps, ["owner", "service"]);
  const reader = requireActor(deps, READERS);
  const runner = requireActor(deps, ["owner", "guest"]);
  const signedIn = requireActor(deps, ["owner", "guest"]);
  const anyActor = requireActor(deps, ["owner", "guest", "viewer", "worker", "service"]);
  const guestRunLimit = deps.session.guestRunsPerHour ?? DEFAULT_GUEST_RUNS_PER_HOUR;
  const ownerId = (res: Response) => {
    const a = actorOf(res);
    return a.kind === "owner" ? a.ownerPubkey : "";
  };
  const wsId = (res: Response) => {
    const a = actorOf(res);
    if (a.kind === "service") return requireWorkspace(ledger).id;
    return a.workspaceId;
  };
  const viewing = (res: Response) => isViewer(actorOf(res));

  // Browser session. Reports who the cookie belongs to without exposing session or CSRF material.
  r.get("/session", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const publicView = deps.session.publicView === true;
    const cookie = readCookie(req, SESSION_COOKIE);
    const s = cookie ? authenticateSession(ledger, cookie, deps.session.guestPubkeys) : null;
    if (s) {
      res.json({ role: s.role, address: s.pubkey, expiresAt: new Date(s.expiresAtMs).toISOString(), publicView });
      return;
    }
    res.json({ role: publicView ? "viewer" : "none", address: null, expiresAt: null, publicView });
  });

  r.post("/session/challenge", (req, res) => {
    assertOrigin(deps, req);
    const body = parse(sessionChallengeRequestSchema, req.body);
    res.status(201).json(createChallenge(ledger, deps.session, body.address));
  });

  r.post("/session/verify", async (req, res) => {
    assertOrigin(deps, req);
    const body = parse(sessionVerifyRequestSchema, req.body);
    const issued = await verifyChallenge(ledger, deps.session, body);
    const secure = deps.session.secureCookies || req.secure;
    res.setHeader("Set-Cookie", sessionCookie(issued.sessionToken, Math.floor(deps.session.sessionTtlMs / 1000), secure));
    res.status(200).json({
      role: issued.role,
      address: issued.address,
      ...(issued.role === "owner" ? { ownerPubkey: issued.address } : {}),
      csrfToken: issued.csrfToken,
      expiresAt: issued.expiresAt,
    });
  });

  r.post("/session/logout", signedIn, (req, res) => {
    const a = actorOf(res);
    if (a.kind === "owner" || a.kind === "guest") revokeSession(ledger, a.sessionId);
    res.setHeader("Set-Cookie", clearedSessionCookie(deps.session.secureCookies || req.secure));
    res.status(204).end();
  });

  // Workspace
  r.get("/workspace", reader, (_req, res) => {
    const ws = requireWorkspace(ledger, wsId(res));
    const services = ledger.db
      .prepare(`SELECT id, service_key, origin, gateway_identity, recipient, network, mint, status FROM approved_service WHERE workspace_id = ?`)
      .all(ws.id) as Array<Record<string, unknown>>;
    const skus = ledger.db
      .prepare(
        `SELECT s.service_id, s.sku, s.payment_path, s.price_usdc, s.max_fee_usdc, s.usage_units, s.enabled FROM service_sku s
         JOIN approved_service a ON a.id = s.service_id WHERE a.workspace_id = ? ORDER BY s.sku, s.payment_path`,
      )
      .all(ws.id) as Array<{ service_id: string; sku: string; payment_path: string; price_usdc: bigint; max_fee_usdc: bigint; usage_units: bigint; enabled: bigint }>;
    res.json({
      workspace: {
        id: ws.id,
        ownerPubkey: ws.owner_pubkey,
        network: ws.network,
        mint: ws.mint,
        mintDecimals: num(ws.mint_decimals),
        policyVersion: num(ws.policy_version),
        emergencyStopEpoch: num(ws.emergency_stop_epoch),
        stopped: ws.stopped === 1n,
        timezone: ws.timezone,
      },
      agents: listAgents(ledger, ws.id).map((a) => agentView(ledger, a)),
      policies: listPolicies(ledger, ws.id).map(policyView),
      services: services.map((s) => ({
        ...s,
        skus: skus
          .filter((k) => k.service_id === s.id)
          .map((k) => ({
            sku: k.sku,
            paymentPath: k.payment_path,
            priceUsdc: big(k.price_usdc).toString(),
            maxFeeUsdc: big(k.max_fee_usdc).toString(),
            usageUnits: big(k.usage_units).toString(),
            enabled: k.enabled === 1n,
          })),
      })),
    });
  });

  r.post("/workspace/stop", owner, (req, res) => {
    const body = parse(workspaceStopRequestSchema, req.body);
    const ws = emergencyStop(ledger, wsId(res), ownerId(res), body.reason);
    res.json({ stopped: ws.stopped === 1n, emergencyStopEpoch: num(ws.emergency_stop_epoch) });
  });

  r.post("/workspace/resume", owner, (_req, res) => {
    const ws = resumeWorkspace(ledger, wsId(res), ownerId(res));
    res.json({ stopped: ws.stopped === 1n, emergencyStopEpoch: num(ws.emergency_stop_epoch) });
  });

  r.post("/workspace/policy", owner, (req, res) => {
    const body = parse(workspacePolicyRequestSchema, req.body);
    const workspaceId = wsId(res);
    let draft: Record<string, unknown> | null = null;
    if (body.policy) {
      const policy = body.policy;
      draft = policyView(immediate(ledger.db, () => insertWorkspacePolicyDraft(ledger, workspaceId, policy, "owner")));
    }
    const activated =
      body.activateVersion !== undefined
        ? policyView(activatePolicyVersion(ledger, workspaceId, null, body.activateVersion, { type: "owner", id: ownerId(res) }))
        : null;
    res.status(draft ? 201 : 200).json({ draft, activated });
  });

  r.get("/activity", reader, (req, res) => {
    const q = parse(activityQuerySchema, req.query);
    const workspaceId = wsId(res);
    const purchases = ledger.db
      .prepare(`SELECT * FROM purchase WHERE workspace_id = ? ORDER BY created_at_ms DESC LIMIT ?`)
      .all(workspaceId, q.limit) as PurchaseRow[];
    const events = activity(ledger, workspaceId, q.limit, q.before);
    const views = purchases.map((p) => purchaseView(ledger, p));
    res.json(viewing(res) ? { events: redactActivityEvents(events), purchases: views.map(redactPurchase) } : { events, purchases: views });
  });

  r.get("/balances", reader, async (_req, res) => {
    const balances = await fullBalances(ledger, requireWorkspace(ledger, wsId(res)), integration?.gateway);
    res.json(viewing(res) ? redactBalances(balances) : balances);
  });

  // Agents
  r.post("/agents", owner, (req, res) => {
    const body = parse(createAgentRequestSchema, req.body);
    const workspaceId = wsId(res);
    const agent = immediate(ledger.db, () => {
      const a = insertAgent(ledger, workspaceId, body, "owner");
      writeAudit(ledger, {
        workspaceId,
        scope: `agent:${a.id}`,
        actorType: "owner",
        actorId: ownerId(res),
        action: "agent.create",
        policyResult: "not_applicable",
        details: { role: a.role },
      });
      return a;
    });
    res.status(201).json({ agent: agentView(ledger, agent), policyDraftVersion: 1 });
  });

  r.patch("/agents/:id/config", owner, (req, res) => {
    const body = parse(agentConfigPatchSchema, req.body);
    const workspaceId = wsId(res);
    const agentId = param(req, "id");
    const draft = immediate(ledger.db, () => {
      const agent = requireAgent(ledger, workspaceId, agentId);
      if (agent.status === "revoked" || agent.status === "archived") throw new ControlError("ACCOUNT_STOPPED", `agent is ${agent.status}`);
      ledger.db
        .prepare(
          `UPDATE agent SET name = ifnull(?, name), description = ifnull(?, description), trigger_json = ifnull(?, trigger_json),
             model_profile = ifnull(?, model_profile), updated_at_ms = ? WHERE id = ?`,
        )
        .run(
          body.name ?? null,
          body.description ?? null,
          body.trigger ? JSON.stringify(body.trigger) : null,
          body.modelProfile ?? null,
          ledger.now(),
          agentId,
        );
      const created = body.policy ? insertAgentPolicyDraft(ledger, workspaceId, agentId, body.policy, "owner") : null;
      writeAudit(ledger, {
        workspaceId,
        scope: `agent:${agentId}`,
        actorType: "owner",
        actorId: ownerId(res),
        action: "agent.configure",
        policyResult: "not_applicable",
        details: { fields: Object.keys(body), draftVersion: created ? num(created.version) : null },
      });
      return created;
    });
    const activated =
      body.activatePolicyVersion !== undefined
        ? activatePolicyVersion(ledger, workspaceId, agentId, body.activatePolicyVersion, { type: "owner", id: ownerId(res) })
        : null;
    res.json({
      agent: agentView(ledger, requireAgent(ledger, workspaceId, agentId)),
      draft: draft ? policyView(draft) : null,
      activated: activated ? policyView(activated) : null,
    });
  });

  r.post("/agents/:id/run", runner, async (req, res) => {
    const body = parse(runAgentRequestSchema, req.body);
    const workspaceId = wsId(res);
    const agent = requireAgent(ledger, workspaceId, param(req, "id"));
    const ws = requireWorkspace(ledger, workspaceId);
    if (ws.stopped === 1n) throw new ControlError("ACCOUNT_STOPPED", "workspace emergency stop is active");
    if (agent.status !== "active") throw new ControlError("ACCOUNT_STOPPED", `agent is ${agent.status}`);
    const caller = actorOf(res);
    const guest = caller.kind === "guest" ? caller : null;
    if (guest) {
      // Task budgets are spending policy, which only the owner sets.
      if (body.taskLimitTestUsdc !== undefined) denyGuestRun(ledger, guest, agent.id, "guests cannot set a task spending limit");
      if (guestRunsInLastHour(ledger, guest) >= guestRunLimit) denyGuestRun(ledger, guest, agent.id, `guest run limit reached (${guestRunLimit} per hour)`);
    }
    /**
     * Runs inside the transaction that creates or finds the job, so concurrent guest requests
     * cannot exceed the hourly limit and every admitted guest run is audited with its job.
     */
    const recordGuestRun = <J extends { job: { id: string }; created: boolean }>(job: J): J => {
      if (!guest) return job;
      if (guestRunsInLastHour(ledger, guest) >= guestRunLimit) throw new ControlError("POLICY_DENIED", `guest run limit reached (${guestRunLimit} per hour)`);
      writeAudit(ledger, {
        workspaceId,
        scope: `agent:${agent.id}`,
        actorType: "system",
        actorId: guest.guestPubkey,
        action: "agent.run",
        policyResult: "allowed",
        details: { actor: "guest", role: agent.role, jobId: job.job.id, created: job.created },
      });
      return job;
    };
    let result: ReturnType<typeof enqueueJob>;
    let check: unknown;
    if (agent.role === "credit_manager") {
      const retry = body.input?.retry === true ? RETRY_MARKER : ":";
      result = immediate(ledger.db, () =>
        recordGuestRun(
          enqueueJob(ledger, {
            workspaceId,
            agentId: agent.id,
            kind: "credit_check",
            triggerKey: `manual:${agent.id}${retry}${body.triggerKey ?? ledger.newId()}`,
          }),
        ),
      );
      if (integration && result.created) {
        // "Check now" runs the same deterministic check the scheduler runs.
        const jobId = result.job.id;
        const ran = (await integration.scheduler.runCreditJobs()).find((x) => x.job.id === jobId);
        check = ran?.result ?? null;
        if (ran) result = { job: ran.job, created: true };
      }
    } else {
      let input: Record<string, unknown>;
      let objective = body.objective;
      if (agent.role === "research") {
        const parsed = researchTaskInputSchema.safeParse({ question: objective, ...(body.input ?? {}) });
        if (!parsed.success) throw new ControlError("INVALID_REQUEST", parsed.error.issues.map((i) => `input.${i.path.join(".")}: ${i.message}`).join("; "));
        input = parsed.data;
        objective = objective ?? parsed.data.question;
      } else {
        const parsed = campaignBriefSchema.safeParse(body.input ?? {});
        if (!parsed.success) throw new ControlError("INVALID_REQUEST", parsed.error.issues.map((i) => `input.${i.path.join(".")}: ${i.message}`).join("; "));
        input = parsed.data;
        objective = objective ?? `Campaign: ${parsed.data.topic}`;
      }
      const triggerKey = `task:${agent.id}:${body.triggerKey ?? ledger.newId()}`;
      result = immediate(ledger.db, () => {
        const existing = ledger.db.prepare(`SELECT id FROM job WHERE trigger_key = ?`).pluck().get(triggerKey);
        if (existing !== undefined) {
          return recordGuestRun(enqueueJob(ledger, { workspaceId, agentId: agent.id, kind: agent.role === "research" ? "research" : "content", triggerKey }));
        }
        const handoffId = typeof input.handoffId === "string" ? input.handoffId : undefined;
        if (handoffId !== undefined) {
          // Runs the task reserved by an owner-approved handoff, adding this brief to it.
          const reserved = ledger.db
            .prepare(`SELECT t.id, t.input_json FROM handoff_task h JOIN task t ON t.id = h.task_id WHERE h.handoff_id = ? AND t.agent_id = ? AND t.state = 'queued'`)
            .get(handoffId, agent.id) as { id: string; input_json: string } | undefined;
          if (!reserved) throw new ControlError("POLICY_DENIED", "no queued task from an approved handoff for this agent");
          const merged = { ...(JSON.parse(reserved.input_json) as Record<string, unknown>), ...input };
          ledger.db
            .prepare(`UPDATE task SET objective = ?, input_json = ?, deadline_at_ms = ?, updated_at_ms = ? WHERE id = ?`)
            .run(objective, JSON.stringify(merged), body.deadline === undefined ? null : Date.parse(body.deadline), ledger.now(), reserved.id);
          return recordGuestRun(enqueueJob(ledger, { workspaceId, agentId: agent.id, taskId: reserved.id, kind: "content", triggerKey }));
        }
        const task = createTask(ledger, {
          workspaceId,
          agent,
          objective: objective as string,
          input,
          limitUsdc: body.taskLimitTestUsdc,
          deadlineMs: body.deadline === undefined ? null : Date.parse(body.deadline),
        });
        return recordGuestRun(
          enqueueJob(ledger, {
            workspaceId,
            agentId: agent.id,
            taskId: task.id,
            kind: agent.role === "research" ? "research" : "content",
            triggerKey,
          }),
        );
      });
    }
    const taskId = result.job.task_id;
    res.status(result.created ? 202 : 200).json({
      job: jobView(result.job),
      taskId,
      executor:
        agent.role === "credit_manager" && integration
          ? "deterministic credit check executed by the control scheduler"
          : "queued in the durable scheduler; execution starts when an agent runner claims it",
      ...(check !== undefined ? { check } : {}),
    });
  });

  r.post("/agents/:id/pause", owner, (req, res) => {
    res.json({ agent: agentView(ledger, pauseAgent(ledger, wsId(res), param(req, "id"), ownerId(res))) });
  });

  r.post("/agents/:id/resume", owner, (req, res) => {
    res.json({ agent: agentView(ledger, resumeAgent(ledger, wsId(res), param(req, "id"), ownerId(res))) });
  });

  r.post("/agents/:id/revoke", owner, (req, res) => {
    res.json({ agent: agentView(ledger, revokeAgent(ledger, wsId(res), param(req, "id"), ownerId(res))) });
  });

  r.post("/agents/:id/worker-credentials", owner, (req, res) => {
    const issued = issueWorkerCredential(ledger, wsId(res), param(req, "id"), ownerId(res));
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json(issued);
  });

  // Purchases
  r.post("/purchase-intents", worker, async (req, res) => {
    const a = actorOf(res);
    if (a.kind !== "worker") throw new ControlError("FORBIDDEN", "worker credential required");
    const body = parse(purchaseIntentRequestSchema, req.body);
    if (body.agentId !== undefined && body.agentId !== a.agentId) {
      immediate(ledger.db, () =>
        writeAudit(ledger, {
          workspaceId: a.workspaceId,
          scope: `agent:${a.agentId}`,
          actorType: "worker",
          actorId: a.agentId,
          action: "purchase.authorize",
          policyResult: "denied",
          reasonCode: "POLICY_DENIED",
          details: { reason: "agent scope mismatch" },
        }),
      );
      throw new ControlError("POLICY_DENIED", "agent scope mismatch: requests act only for the credential's agent");
    }
    chargeWorkerCall(ledger, req, a.agentId, body.taskId, body.paymentPath === "prepaid_credits" ? "consume_inference_sku" : "request_purchase");
    const result = authorizePurchase(ledger, {
      workspaceId: a.workspaceId,
      agentId: a.agentId,
      idempotencyKey: body.idempotencyKey,
      serviceId: body.serviceId,
      sku: body.sku,
      paymentPath: body.paymentPath,
      requestDigest: body.requestDigest,
      taskId: body.taskId,
      rationale: body.rationale,
    });
    let purchase = result.purchase;
    let execution: unknown;
    if (integration && body.input !== undefined) {
      integration.orchestrator.storeInput(purchase, body.input);
      if (purchase.authorization_state !== "awaiting_approval") {
        const driven = await integration.orchestrator.driveUntilSettled(purchase.id);
        purchase = driven.purchase;
        execution = driven.execution;
      } else {
        execution = integration.orchestrator.view(purchase.id);
      }
    }
    const view = purchaseView(ledger, purchase);
    const awaiting = purchase.authorization_state === "awaiting_approval";
    res.status(awaiting ? 202 : result.created ? 201 : 200).json({
      purchase: view,
      created: result.created,
      ...(execution !== undefined ? { execution } : {}),
      ...(awaiting ? { code: "APPROVAL_REQUIRED" } : {}),
    });
  });

  r.get("/purchases/:id", anyActor, (req, res) => {
    const a = actorOf(res);
    const p = getPurchaseRow(ledger, param(req, "id"));
    if (a.kind === "worker" && p.agent_id !== a.agentId) {
      throw new ControlError("POLICY_DENIED", "agent scope mismatch");
    }
    if ((a.kind === "owner" || a.kind === "guest" || a.kind === "viewer") && p.workspace_id !== a.workspaceId) {
      throw new ControlError("NOT_FOUND", "purchase not found");
    }
    if (a.kind === "worker") chargeWorkerCall(ledger, req, a.agentId, undefined, "purchase_status");
    if (a.kind === "viewer") {
      res.json({ purchase: redactPurchase(purchaseView(ledger, p)) });
      return;
    }
    res.json({ purchase: purchaseView(ledger, p), ...(integration ? { execution: integration.orchestrator.view(p.id) } : {}) });
  });

  r.post("/purchases/:id/decision", owner, (req, res) => {
    const body = parse(purchaseDecisionRequestSchema, req.body);
    const p = getPurchaseRow(ledger, param(req, "id"));
    if (p.workspace_id !== wsId(res)) throw new ControlError("NOT_FOUND", "purchase not found");
    res.json({ purchase: purchaseView(ledger, decidePurchase(ledger, p.id, body.decision, ownerId(res))) });
  });

  r.post("/purchases/:id/reconcile", ownerOrService, async (req, res) => {
    parse(reconcileRequestSchema, req.body);
    const p = getPurchaseRow(ledger, param(req, "id"));
    if (p.workspace_id !== wsId(res)) throw new ControlError("NOT_FOUND", "purchase not found");
    if (integration?.orchestrator.configured && integration.orchestrator.input(p.id) !== undefined) {
      // Reconciliation queries the existing gateway/wallet operation; it never creates a new one.
      const before = JSON.stringify(purchaseView(ledger, p).states);
      const driven = await integration.orchestrator.driveUntilSettled(p.id);
      const view = purchaseView(ledger, driven.purchase);
      res.json({ purchase: view, execution: driven.execution, reconciled: true, changed: JSON.stringify(view.states) !== before });
      return;
    }
    const view = purchaseView(ledger, p);
    const reservation = view.reservation as { status: string };
    const nothingReleased =
      p.authorization_state !== "released" &&
      (p.funding_state === "not_started" || p.funding_state === "not_required" || p.funding_state === "abandoned");
    if (reservation.status !== "active" || nothingReleased) {
      res.json({ purchase: view, reconciled: true, changed: false });
      return;
    }
    throw new ControlError(
      "NOT_READY",
      "this purchase has released authority; chain and gateway reconciliation is not available yet, state left unchanged",
    );
  });

  // Worker tools
  r.get("/worker/catalog", worker, (req, res) => {
    const a = actorOf(res);
    if (a.kind !== "worker") throw new ControlError("FORBIDDEN", "worker credential required");
    chargeWorkerCall(ledger, req, a.agentId, undefined, "catalog_lookup");
    const policy = activeAgentPolicy(ledger, a.agentId);
    const perms = policy ? agentPermissions(policy) : { allowedSkus: [], allowedPaymentPaths: [] };
    const rows = ledger.db
      .prepare(
        `SELECT a.id AS service_id, a.service_key, a.status, s.sku, s.payment_path, s.price_usdc, s.max_fee_usdc, s.usage_units
         FROM service_sku s JOIN approved_service a ON a.id = s.service_id WHERE a.workspace_id = ? AND s.enabled = 1
         ORDER BY a.service_key, s.sku, s.payment_path`,
      )
      .all(a.workspaceId) as Array<{ service_id: string; service_key: string; status: string; sku: string; payment_path: string; price_usdc: bigint; max_fee_usdc: bigint; usage_units: bigint }>;
    res.json({
      items: rows
        .filter((s) => perms.allowedSkus.includes(s.sku) && perms.allowedPaymentPaths.includes(s.payment_path))
        .map((s) => ({
          serviceId: s.service_id,
          service: s.service_key,
          bindingStatus: s.status,
          sku: s.sku,
          paymentPath: s.payment_path,
          price: { amount: big(s.price_usdc).toString(), unit: "usdc_base_units" },
          maxFee: { amount: big(s.max_fee_usdc).toString(), unit: "usdc_base_units" },
          usage: { amount: big(s.usage_units).toString(), unit: "gateway_microcredits" },
        })),
    });
  });

  r.get("/worker/budget", worker, (req, res) => {
    const a = actorOf(res);
    if (a.kind !== "worker") throw new ControlError("FORBIDDEN", "worker credential required");
    chargeWorkerCall(ledger, req, a.agentId, undefined, "budget_summary");
    res.json(agentBudget(ledger, requireAgent(ledger, a.workspaceId, a.agentId)));
  });

  r.post("/worker/artifacts", worker, (req, res) => {
    const a = actorOf(res);
    if (a.kind !== "worker") throw new ControlError("FORBIDDEN", "worker credential required");
    const body = parse(saveArtifactRequestSchema, req.body);
    const agent = requireAgent(ledger, a.workspaceId, a.agentId);
    chargeWorkerCall(ledger, req, a.agentId, body.taskId, "save_artifact");
    // Evidence exists only through the purchase integration, so that is where citations are checked.
    if (body.kind === "research_brief" && integration) validateResearchCitations(ledger, agent.id, body);
    if (body.kind === "content_calendar" && integration) {
      let entries: unknown;
      try {
        entries = JSON.parse(body.content);
      } catch {
        entries = undefined;
      }
      if (!calendarSchema.safeParse(entries).success) throw new ControlError("INVALID_REQUEST", "calendar content must be seven valid entries");
    }
    res.status(201).json(saveArtifact(ledger, agent, body));
  });

  r.post("/worker/handoffs", worker, (req, res) => {
    const a = actorOf(res);
    if (a.kind !== "worker") throw new ControlError("FORBIDDEN", "worker credential required");
    const body = parse(handoffRequestSchema, req.body);
    const agent = requireAgent(ledger, a.workspaceId, a.agentId);
    chargeWorkerCall(ledger, req, a.agentId, undefined, "request_handoff");
    res.status(201).json({ ...requestHandoff(ledger, agent, body), state: "pending_owner" });
  });

  return r;
}
