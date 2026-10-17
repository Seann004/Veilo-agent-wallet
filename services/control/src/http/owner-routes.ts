import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { immediate } from "@veilo/db";
import { iso, num, type Ledger } from "../context";
import { ControlError } from "../errors";
import { taskView, type TaskRow } from "../agents/work";
import { revokeAgent } from "../ledger/authority";
import { writeAudit } from "../ledger/events";
import { jobView, type JobRow } from "../ledger/jobs";
import { requireAgent } from "../ledger/workspace";
import { actorOf, requireActor, type AuthDeps } from "./actor";

const param = (req: Request, name: string): string => {
  const v = req.params[name];
  if (typeof v !== "string" || !/^[0-9a-f-]{36}$/.test(v)) throw new ControlError("NOT_FOUND", "resource not found");
  return v;
};

const taskQuerySchema = z
  .object({
    agentId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

function jobsFor(ledger: Ledger, workspaceId: string, agentId: string | undefined, limit: number): Array<Record<string, unknown>> {
  const rows = ledger.db
    .prepare(
      `SELECT * FROM job WHERE workspace_id = ? AND (? IS NULL OR agent_id = ?) ORDER BY created_at_ms DESC LIMIT ?`,
    )
    .all(workspaceId, agentId ?? null, agentId ?? null, limit) as Array<JobRow & { created_at_ms: bigint; updated_at_ms: bigint }>;
  return rows.map((j) => ({
    ...jobView(j),
    result: j.result_json === null ? null : (JSON.parse(j.result_json) as unknown),
    createdAt: iso(j.created_at_ms),
    updatedAt: iso(j.updated_at_ms),
  }));
}

/**
 * Owner read views of tasks and jobs, and agent archiving. Reads only; archiving revokes the
 * agent's authority through the same serialized path as revoke before marking it archived.
 */
export function ownerRouter(deps: AuthDeps): Router {
  const { ledger } = deps;
  const r = Router();
  const owner = requireActor(deps, ["owner"]);
  const ownerOf = (res: Response) => {
    const a = actorOf(res);
    if (a.kind !== "owner") throw new ControlError("FORBIDDEN", "owner session required");
    return a;
  };

  r.get("/tasks", owner, (req, res) => {
    const o = ownerOf(res);
    const parsed = taskQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) throw new ControlError("INVALID_REQUEST", parsed.error.issues.map((i) => `${i.path.join(".") || "(query)"}: ${i.message}`).join("; "));
    const q = parsed.data;
    if (q.agentId !== undefined) requireAgent(ledger, o.workspaceId, q.agentId);
    const tasks = ledger.db
      .prepare(
        `SELECT * FROM task WHERE workspace_id = ? AND (? IS NULL OR agent_id = ?) ORDER BY created_at_ms DESC LIMIT ?`,
      )
      .all(o.workspaceId, q.agentId ?? null, q.agentId ?? null, q.limit) as Array<TaskRow & { updated_at_ms: bigint }>;
    res.json({
      tasks: tasks.map((t) => ({ ...taskView(t), updatedAt: iso(t.updated_at_ms) })),
      jobs: jobsFor(ledger, o.workspaceId, q.agentId, q.limit),
    });
  });

  r.post("/agents/:id/archive", owner, (req, res) => {
    const o = ownerOf(res);
    const agentId = param(req, "id");
    revokeAgent(ledger, o.workspaceId, agentId, o.ownerPubkey);
    const agent = immediate(ledger.db, () => {
      const a = requireAgent(ledger, o.workspaceId, agentId);
      if (a.status !== "archived") {
        ledger.db.prepare(`UPDATE agent SET status = 'archived', updated_at_ms = ? WHERE id = ?`).run(ledger.now(), agentId);
        writeAudit(ledger, {
          workspaceId: o.workspaceId,
          scope: `agent:${agentId}`,
          actorType: "owner",
          actorId: o.ownerPubkey,
          action: "agent.archive",
          policyResult: "not_applicable",
        });
      }
      return requireAgent(ledger, o.workspaceId, agentId);
    });
    res.json({ agent: { id: agent.id, name: agent.name, role: agent.role, status: agent.status, revocationEpoch: num(agent.revocation_epoch) } });
  });

  return r;
}
