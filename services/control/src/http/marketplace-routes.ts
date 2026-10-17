import { Router, type Request, type Response } from "express";
import type { z } from "zod";
import {
  controllerRegistrationRequestSchema,
  marketplaceAllowlistRequestSchema,
  marketplaceHireApprovalSchema,
  marketplaceHireRejectionSchema,
  marketplaceOperationIdSchema,
  marketplaceSearchQuerySchema,
  workerHireRequestSchema,
} from "@veilo/contracts";
import { ControlError } from "../errors";
import { assertTaskLive, chargeToolCall, ownTask } from "../agents/work";
import type { Integration } from "../integration";
import type { HireState, MarketplaceBridge } from "../marketplace/bridge";
import { requireAgent } from "../ledger/workspace";
import { actorOf, requireActor, type AuthDeps } from "./actor";

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    const details = r.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; ");
    throw new ControlError("INVALID_REQUEST", details);
  }
  return r.data;
}

const uuidParam = (req: Request, name: string): string => {
  const v = req.params[name];
  if (typeof v !== "string" || !/^[0-9a-f-]{36}$/.test(v)) throw new ControlError("NOT_FOUND", "resource not found");
  return v;
};

const opParam = (req: Request): string => {
  const r = marketplaceOperationIdSchema.safeParse(req.params.operationId);
  if (!r.success) throw new ControlError("NOT_FOUND", "marketplace hire not found");
  return r.data;
};

const PENDING: readonly HireState[] = ["received", "awaiting_approval"];

/**
 * Owner marketplace controls (session, CSRF and Origin protected) and the two custom-agent
 * tools. Nothing here is reachable without an owner session or a worker credential; the
 * controller itself only makes outbound calls.
 */
export function marketplaceRouter(deps: AuthDeps & { integration?: Integration | undefined }): Router {
  const { ledger } = deps;
  const r = Router();
  const owner = requireActor(deps, ["owner"]);
  const worker = requireActor(deps, ["worker"]);
  const ownerOf = (res: Response) => {
    const a = actorOf(res);
    if (a.kind !== "owner") throw new ControlError("FORBIDDEN", "owner session required");
    return a;
  };
  const bridge = (): MarketplaceBridge => {
    const b = deps.integration?.marketplace;
    if (!b) throw new ControlError("NOT_READY", "the marketplace is not configured (MARKETPLACE_URL)");
    return b;
  };

  r.get("/marketplace/controller", owner, (_req, res) => {
    ownerOf(res);
    const b = deps.integration?.marketplace;
    if (!b) {
      res.json({ configured: false });
      return;
    }
    const reg = b.registration();
    res.json({
      configured: true,
      marketplaceUrl: b.deps.client.baseUrl,
      controllerKey: b.deps.identity.publicKey,
      keyId: b.deps.identity.keyId,
      registration: reg ? { cloudWorkspaceId: reg.cloud_workspace_id, cloudUserId: reg.cloud_user_id } : null,
    });
  });

  r.post("/marketplace/controller/registration", owner, (req, res) => {
    const o = ownerOf(res);
    const body = parse(controllerRegistrationRequestSchema, req.body);
    res.setHeader("Cache-Control", "no-store");
    res.json(bridge().register(o, body.workspaceId, body.userId));
  });

  r.get("/marketplace/hires", owner, (req, res) => {
    const o = ownerOf(res);
    const b = bridge();
    const all = req.query.state === "all";
    res.json({ items: b.list(o.workspaceId, all ? null : PENDING).map((h) => b.hireView(h)) });
  });

  r.post("/marketplace/hires/:operationId/approve", owner, async (req, res) => {
    const o = ownerOf(res);
    const b = bridge();
    const h = await b.approve(o, opParam(req), parse(marketplaceHireApprovalSchema, req.body));
    res.json({ hire: b.hireView(h) });
  });

  r.post("/marketplace/hires/:operationId/reject", owner, async (req, res) => {
    const o = ownerOf(res);
    const b = bridge();
    const body = parse(marketplaceHireRejectionSchema, req.body);
    res.json({ hire: b.hireView(await b.reject(o, opParam(req), body.reason)) });
  });

  r.get("/agents/:id/marketplace-allowlist", owner, (req, res) => {
    const o = ownerOf(res);
    const agent = requireAgent(ledger, o.workspaceId, uuidParam(req, "id"));
    const b = bridge();
    res.json({ agentId: agent.id, grants: b.grants(agent.id).map((g) => b.grantView(g)) });
  });

  r.put("/agents/:id/marketplace-allowlist", owner, (req, res) => {
    const o = ownerOf(res);
    const b = bridge();
    const body = parse(marketplaceAllowlistRequestSchema, req.body);
    const grants = b.setAllowlist(o, uuidParam(req, "id"), body.grants);
    res.json({ grants: grants.map((g) => b.grantView(g)) });
  });

  // Custom-agent tools. Identity comes from the worker credential only.
  const customAgent = (res: Response) => {
    const a = actorOf(res);
    if (a.kind !== "worker") throw new ControlError("FORBIDDEN", "worker credential required");
    const agent = requireAgent(ledger, a.workspaceId, a.agentId);
    if (agent.role !== "custom") throw new ControlError("FORBIDDEN", "marketplace tools are available to custom agents only");
    if (agent.status !== "active") throw new ControlError("ACCOUNT_STOPPED", `agent is ${agent.status}`);
    return agent;
  };

  r.get("/worker/marketplace/search", worker, async (req, res) => {
    const agent = customAgent(res);
    // Every search is charged to a live task of this agent, so the tool-call bound always applies.
    const header = req.headers["x-veilo-task-id"];
    if (typeof header !== "string" || header.length === 0) throw new ControlError("INVALID_REQUEST", "x-veilo-task-id header is required");
    const task = ownTask(ledger, agent.id, header);
    assertTaskLive(ledger, task);
    chargeToolCall(ledger, agent.id, task.id, "marketplace_search");
    const q = parse(marketplaceSearchQuerySchema, req.query);
    res.json(await bridge().search(q.q));
  });

  r.post("/worker/hires", worker, async (req, res) => {
    const agent = customAgent(res);
    const body = parse(workerHireRequestSchema, req.body);
    const b = bridge();
    const task = ownTask(ledger, agent.id, body.taskId);
    assertTaskLive(ledger, task);
    chargeToolCall(ledger, agent.id, task.id, "propose_hire");
    res.status(202).json(await b.propose(agent, task, body));
  });

  return r;
}
