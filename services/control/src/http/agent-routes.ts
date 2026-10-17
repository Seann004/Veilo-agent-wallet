import { Router, type Request, type Response } from "express";
import type { ChannelService } from "../channels/service";
import { z } from "zod";
import {
  contentPatchSchema,
  contentQuerySchema,
  contentReviewSchema,
  handoffDecisionSchema,
  jobClaimSchema,
  jobCompleteSchema,
  jobHeartbeatSchema,
  planningProxyRequestSchema,
} from "@veilo/contracts";
import { ControlError } from "../errors";
import { calendarView, decideHandoff, editContent, listContent, listHandoffs, reviewContent } from "../agents/content";
import { claimWorkerJob, completeWorkerJob, heartbeatWorkerJob, ownTask, sponsoredPlanning, taskView } from "../agents/work";
import type { Integration } from "../integration";
import { requireAgent } from "../ledger/workspace";
import { READERS, actorOf, requireActor, type AuthDeps } from "./actor";
import { AI_SKUS, type AiService } from "../ai/service";
import { browsePermit } from "../agents/browse";

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
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

/**
 * Content/handoff reads for every workspace role, owner-only edits and decisions, and the runner's
 * job/planning endpoints. None of these perform inference, purchases or publishing on behalf of an edit or approval.
 */
export function agentRouter(deps: AuthDeps & { integration?: Integration | undefined; ai?: AiService | undefined; channels?: ChannelService | undefined }): Router {
  const { ledger } = deps;
  const r = Router();
  const owner = requireActor(deps, ["owner"]);
  const worker = requireActor(deps, ["worker"]);
  const reader = requireActor(deps, READERS);
  const readerWorkspace = (res: Response): string => {
    const a = actorOf(res);
    if (a.kind !== "owner" && a.kind !== "guest" && a.kind !== "viewer") throw new ControlError("FORBIDDEN", "workspace session required");
    return a.workspaceId;
  };
  const ownerOf = (res: Response) => {
    const a = actorOf(res);
    if (a.kind !== "owner") throw new ControlError("FORBIDDEN", "owner session required");
    return a;
  };
  const workerAgent = (res: Response) => {
    const a = actorOf(res);
    if (a.kind !== "worker") throw new ControlError("FORBIDDEN", "worker credential required");
    return requireAgent(ledger, a.workspaceId, a.agentId);
  };

  r.get("/content", reader, (req, res) => {
    res.json({ items: listContent(ledger, readerWorkspace(res), parse(contentQuerySchema, req.query)) });
  });

  r.patch("/content/:id", owner, (req, res) => {
    const o = ownerOf(res);
    res.json({ item: editContent(ledger, o.workspaceId, param(req, "id"), parse(contentPatchSchema, req.body), o.ownerPubkey) });
  });

  r.post("/content/:id/review", owner, (req, res) => {
    const o = ownerOf(res);
    res.json({ item: reviewContent(ledger, o.workspaceId, param(req, "id"), parse(contentReviewSchema, req.body).state, o.ownerPubkey) });
  });

  r.get("/calendar", reader, (_req, res) => {
    res.json(calendarView(ledger, readerWorkspace(res)));
  });

  r.get("/handoffs", reader, (_req, res) => {
    res.json({ items: listHandoffs(ledger, readerWorkspace(res)) });
  });

  r.post("/handoffs/:id/decision", owner, (req, res) => {
    const o = ownerOf(res);
    res.json(decideHandoff(ledger, o.workspaceId, param(req, "id"), parse(handoffDecisionSchema, req.body).decision, o.ownerPubkey));
  });

  // Runner infrastructure (not model tools): job leases, task reads and sponsored planning.
  r.post("/worker/jobs/claim", worker, (req, res) => {
    const agent = workerAgent(res);
    const body = parse(jobClaimSchema, req.body);
    const claimed = claimWorkerJob(ledger, agent, body.workerId, body.leaseMs);
    res.status(claimed ? 200 : 204);
    if (claimed) res.json(claimed);
    else res.end();
  });

  r.post("/worker/jobs/:id/heartbeat", worker, (req, res) => {
    const body = parse(jobHeartbeatSchema, req.body);
    res.json(heartbeatWorkerJob(ledger, workerAgent(res), param(req, "id"), body.workerId, body.version, body.leaseMs));
  });

  r.post("/worker/jobs/:id/complete", worker, (req, res) => {
    const out = completeWorkerJob(ledger, workerAgent(res), param(req, "id"), parse(jobCompleteSchema, req.body));
    const taskId = (out.job as { taskId?: string | null }).taskId;
    // Sent after the reply and outside the transaction; the outcome is recorded on the task.
    if (taskId && deps.channels) void deps.channels.deliverTask(taskId);
    res.json(out);
  });

  r.get("/worker/tasks/:id", worker, (req, res) => {
    res.json({ task: taskView(ownTask(ledger, workerAgent(res).id, param(req, "id"))) });
  });

  r.post("/worker/planning", worker, async (req, res) => {
    const agent = workerAgent(res);
    const body = parse(planningProxyRequestSchema, req.body);
    // The owner's own provider when one is set; operator-sponsored planning is the trial fallback.
    const out = deps.ai?.configured(agent.workspace_id) ? await deps.ai.plan(agent, body) : await sponsoredPlanning(ledger, deps.integration?.gateway, agent, body);
    res.status(out.status).json(out.body);
  });

  r.post("/worker/browse-permit", worker, (req, res) => {
    const body = parse(z.object({ taskId: z.uuid(), url: z.string().min(1).max(2048) }).strict(), req.body);
    res.json(browsePermit(ledger, workerAgent(res), body));
  });

  r.post("/worker/ai", worker, async (req, res) => {
    if (!deps.ai) throw new ControlError("NOT_READY", "model provider settings are not available");
    const body = parse(z.object({ taskId: z.uuid(), sku: z.enum(AI_SKUS), input: z.unknown() }).strict(), req.body);
    res.json(await deps.ai.run(workerAgent(res), body));
  });

  return r;
}
