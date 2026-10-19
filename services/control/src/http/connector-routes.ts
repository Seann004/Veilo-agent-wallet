import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { ControlError } from "../errors";
import type { AgentConnectors } from "../connectors/agent-connectors";
import { requireAgent } from "../ledger/workspace";
import { actorOf, requireActor, type AuthDeps } from "./actor";

const connectorId = z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/);
const toolName = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
const attachSchema = z
  .object({ tools: z.array(toolName).min(1).max(32).refine((t) => new Set(t).size === t.length, "tool names must be unique") })
  .strict();
const previewSchema = z.object({ endpoint: z.string().min(1).max(300) }).strict();
const callSchema = z
  .object({ taskId: z.uuid(), connectorId, tool: toolName, args: z.record(z.string(), z.unknown()) })
  .strict();

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    const details = r.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; ");
    throw new ControlError("INVALID_REQUEST", details);
  }
  return r.data;
}

const agentParam = (req: Request): string => {
  const v = req.params.id;
  if (typeof v !== "string" || !/^[0-9a-f-]{36}$/.test(v)) throw new ControlError("NOT_FOUND", "resource not found");
  return v;
};

const connectorParam = (req: Request): string => {
  const r = connectorId.safeParse(req.params.connectorId);
  if (!r.success) throw new ControlError("NOT_FOUND", "connector not found");
  return r.data;
};

/** Owner attachment of approved read-only MCP connectors, and the runner's call path to them. */
export function connectorRouter(deps: AuthDeps & { connectors?: AgentConnectors | undefined }): Router {
  const r = Router();
  const owner = requireActor(deps, ["owner"]);
  const worker = requireActor(deps, ["worker"]);
  const ownerOf = (res: Response) => {
    const a = actorOf(res);
    if (a.kind !== "owner") throw new ControlError("FORBIDDEN", "owner session required");
    return a;
  };
  const connectors = (): AgentConnectors => {
    if (!deps.connectors) throw new ControlError("NOT_READY", "agent connectors are not configured");
    return deps.connectors;
  };
  const workerAgent = (res: Response) => {
    const a = actorOf(res);
    if (a.kind !== "worker") throw new ControlError("FORBIDDEN", "worker credential required");
    return requireAgent(deps.ledger, a.workspaceId, a.agentId);
  };

  r.get("/agents/:id/connectors", owner, (req, res) => {
    res.json(connectors().list(ownerOf(res).workspaceId, agentParam(req)));
  });

  r.post("/connectors/template-preview", owner, async (req, res) => {
    ownerOf(res);
    res.json(await connectors().templatePreview(parse(previewSchema, req.body).endpoint));
  });

  r.put("/agents/:id/connectors/:connectorId", owner, async (req, res) => {
    const o = ownerOf(res);
    const body = parse(attachSchema, req.body);
    res.json({ attached: await connectors().attach(o, agentParam(req), connectorParam(req), body.tools) });
  });

  r.delete("/agents/:id/connectors/:connectorId", owner, (req, res) => {
    const o = ownerOf(res);
    connectors().detach(o, agentParam(req), connectorParam(req));
    res.status(204).end();
  });

  r.get("/worker/connectors", worker, (_req, res) => {
    res.json(connectors().workerList(workerAgent(res)));
  });

  r.post("/worker/connector-calls", worker, async (req, res) => {
    const agent = workerAgent(res);
    const body = parse(callSchema, req.body);
    res.json(await connectors().call(agent.id, body));
  });

  return r;
}
