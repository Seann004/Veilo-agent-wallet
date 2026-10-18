import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { MARKETPLACE_DELEGATION_DEPTH_KEY } from "@veilo/contracts";
import { MARKETPLACE_LIMITS } from "@veilo/contracts/marketplace";
import { big } from "../context";
import { ControlError } from "../errors";
import { assertTaskLive, chargeToolCall, ownTask } from "../agents/work";
import type { Integration } from "../integration";
import { requireAgent } from "../ledger/workspace";
import { catalogText } from "../workflows/adapters";
import type { WorkflowRunner } from "../workflows/runner";
import { actorOf, requireActor, type AuthDeps } from "./actor";

const uuid = z.uuid();
const runInputs = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.string().max(4000)).refine((r) => Object.keys(r).length <= 4, "at most four run inputs");

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw new ControlError("INVALID_REQUEST", r.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; "));
  return r.data;
}

const idParam = (req: Request, name: string): string => {
  const v = req.params[name];
  if (typeof v !== "string" || !/^[0-9a-f-]{36}$/.test(v)) throw new ControlError("NOT_FOUND", "resource not found");
  return v;
};

/**
 * Local authority for workflow runs. "Run once" prepares the terms and the owner approves their
 * digest; "Add to agent" installs an assignment that pre-approves the agent's proposals within a
 * budget. Agents can only propose; no route lets them approve, assign or change a budget.
 */
export function workflowRouter(deps: AuthDeps & { integration?: Integration | undefined }): Router {
  const { ledger } = deps;
  const r = Router();
  const owner = requireActor(deps, ["owner"]);
  const worker = requireActor(deps, ["worker"]);
  const ownerOf = (res: Response) => {
    const a = actorOf(res);
    if (a.kind !== "owner") throw new ControlError("FORBIDDEN", "owner session required");
    return a;
  };
  const runner = (): WorkflowRunner => {
    const w = deps.integration?.workflows;
    if (!w) throw new ControlError("NOT_READY", "workflow runs need the marketplace (MARKETPLACE_URL) and the wallet service");
    return w;
  };
  const owned = (res: Response, runId: string) => {
    const o = ownerOf(res);
    const run = runner().run(runId);
    if (!run || run.workspace_id !== o.workspaceId) throw new ControlError("NOT_FOUND", "workflow run not found");
    return { o, run };
  };

  r.post("/workflows/runs", owner, async (req, res) => {
    const o = ownerOf(res);
    const b = parse(z.object({ versionId: uuid, agentId: uuid, runInputs, isTest: z.boolean().default(false) }).strict(), req.body);
    requireAgent(ledger, o.workspaceId, b.agentId);
    const run = await runner().prepare({ ...b, requestedBy: "owner" });
    res.status(201).json({ run: runner().view(run.id) });
  });

  r.post("/workflows/runs/:id/approve", owner, async (req, res) => {
    const { o, run } = owned(res, idParam(req, "id"));
    const b = parse(z.object({ approvalDigest: z.string().regex(/^[0-9a-f]{64}$/) }).strict(), req.body);
    await runner().approve(run.id, o.ownerPubkey, b.approvalDigest);
    await runner().advance(run.id);
    res.json({ run: runner().view(run.id) });
  });

  r.post("/workflows/runs/:id/reject", owner, (req, res) => {
    const { o, run } = owned(res, idParam(req, "id"));
    runner().reject(run.id, o.ownerPubkey);
    res.json({ run: runner().view(run.id) });
  });

  r.post("/workflows/runs/:id/advance", owner, async (req, res) => {
    const { run } = owned(res, idParam(req, "id"));
    await runner().advance(run.id);
    res.json({ run: runner().view(run.id) });
  });

  r.get("/workflows/runs", owner, (_req, res) => {
    const o = ownerOf(res);
    const ids = ledger.db.prepare(`SELECT id FROM workflow_run WHERE workspace_id = ? ORDER BY created_at_ms DESC LIMIT 50`).pluck().all(o.workspaceId) as string[];
    res.json({ runs: ids.map((id) => runner().view(id)) });
  });

  r.get("/workflows/runs/:id", owner, (req, res) => {
    const { run } = owned(res, idParam(req, "id"));
    res.json({ run: runner().view(run.id) });
  });

  r.get("/workflows/runs/:id/steps/:index/artifact", owner, (req, res) => {
    const { run } = owned(res, idParam(req, "id"));
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0 || index > 7) throw new ControlError("NOT_FOUND", "resource not found");
    const a = runner().artifact(run.id, index);
    if (!a) throw new ControlError("NOT_FOUND", "no stored output for this step");
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    res.json({ untrusted: true, ...a });
  });

  r.post("/workflows/assignments", owner, async (req, res) => {
    const o = ownerOf(res);
    const b = parse(z.object({ agentId: uuid, versionId: uuid, budgetUsdc: z.string().regex(/^[1-9][0-9]{0,18}$/) }).strict(), req.body);
    requireAgent(ledger, o.workspaceId, b.agentId);
    const id = await runner().assign({ agentId: b.agentId, versionId: b.versionId, budgetUsdc: BigInt(b.budgetUsdc), ownerPubkey: o.ownerPubkey });
    res.status(201).json({ assignmentId: id });
  });

  r.get("/workflows/assignments", owner, (_req, res) => {
    const o = ownerOf(res);
    const rows = ledger.db
      .prepare(
        `SELECT a.id, a.agent_id, a.workflow_id, a.budget_usdc, a.status, a.created_at_ms,
                (SELECT coalesce(sum(total_max_usdc), 0) FROM workflow_run w WHERE w.assignment_id = a.id AND w.status NOT IN ('awaiting_approval', 'rejected')) AS committed
         FROM workflow_assignment a WHERE a.workspace_id = ? ORDER BY a.created_at_ms DESC`,
      )
      .all(o.workspaceId) as Array<{ id: string; agent_id: string; workflow_id: string; budget_usdc: bigint; status: string; committed: bigint; created_at_ms: bigint }>;
    res.json({
      assignments: rows.map((a) => ({ id: a.id, agentId: a.agent_id, workflowId: a.workflow_id, budget: a.budget_usdc.toString(), committed: a.committed.toString(), status: a.status })),
    });
  });

  r.post("/workflows/assignments/:id/revoke", owner, (req, res) => {
    const o = ownerOf(res);
    const id = idParam(req, "id");
    const changed = ledger.db
      .prepare(`UPDATE workflow_assignment SET status = 'revoked', updated_at_ms = ? WHERE id = ? AND workspace_id = ? AND status = 'active'`)
      .run(ledger.now(), id, o.workspaceId).changes;
    if (changed !== 1) throw new ControlError("NOT_FOUND", "active assignment not found");
    res.json({ ok: true });
  });

  const workerAgent = (res: Response) => {
    const a = actorOf(res);
    if (a.kind !== "worker") throw new ControlError("FORBIDDEN", "worker credential required");
    const agent = requireAgent(ledger, a.workspaceId, a.agentId);
    if (agent.status !== "active") throw new ControlError("ACCOUNT_STOPPED", `agent is ${agent.status}`);
    return agent;
  };

  // Only this agent's active assignments, as captured when the owner assigned them.
  r.get("/worker/workflows", worker, (_req, res) => {
    const agent = workerAgent(res);
    const rows = ledger.db
      .prepare(
        `SELECT version_id, title, summary, run_inputs_json, total_usdc FROM workflow_assignment
         WHERE agent_id = ? AND status = 'active' AND version_id IS NOT NULL ORDER BY created_at_ms DESC LIMIT 5`,
      )
      .all(agent.id) as Array<{ version_id: string; title: string | null; summary: string | null; run_inputs_json: string | null; total_usdc: bigint | null }>;
    res.json({
      workflows: rows.map((w) => ({
        versionId: w.version_id,
        title: catalogText(w.title, 120) || "Assigned workflow",
        summary: catalogText(w.summary, 300),
        runInputs: ((JSON.parse(w.run_inputs_json ?? "[]") as Array<{ name: string; label: string; maxChars: number }>) ?? []).slice(0, 4).map((i) => ({ name: i.name, label: catalogText(i.label, 80) || i.name, maxChars: i.maxChars })),
        total: w.total_usdc === null ? null : w.total_usdc.toString(),
      })),
    });
  });

  // Agents propose; the run waits for the owner unless an assignment already covers its exact terms.
  r.post("/worker/workflow-runs", worker, async (req, res) => {
    const agent = workerAgent(res);
    const b = parse(z.object({ taskId: uuid, versionId: uuid, runInputs, idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/).optional() }).strict(), req.body);
    const task = ownTask(ledger, agent.id, b.taskId);
    assertTaskLive(ledger, task);
    const depth = Number((JSON.parse(task.input_json) as Record<string, unknown>)[MARKETPLACE_DELEGATION_DEPTH_KEY] ?? 0);
    if (!Number.isInteger(depth) || depth >= MARKETPLACE_LIMITS.maxDelegationDepth) {
      throw new ControlError("POLICY_DENIED", "delegation depth limit reached: a specialist result cannot start a workflow run");
    }
    chargeToolCall(ledger, agent.id, task.id, "propose_workflow_run");
    const run = await runner().propose({ agentId: agent.id, versionId: b.versionId, runInputs: b.runInputs, taskId: task.id, ...(b.idempotencyKey ? { idempotencyKey: b.idempotencyKey } : {}) });
    res.status(202).json({ runId: run.id, status: run.status, total: big(run.total_max_usdc).toString(), steps: runner().steps(run.id).length });
  });

  return r;
}
