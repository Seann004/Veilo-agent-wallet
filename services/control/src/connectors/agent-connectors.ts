import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@veilo/contracts/gateway";
import { mcpEndpointProblem, mcpToolDigest, mcpToolPinSchema } from "@veilo/contracts/marketplace";
import { immediate } from "@veilo/db";
import { callPinnedTool, McpError, type McpClient } from "@veilo/mcp-client";
import { DAY_MS, iso, num, type Ledger } from "../context";
import { ControlError } from "../errors";
import { assertTaskLive, chargeToolCall, connectorCitation, ownTask } from "../agents/work";
import { writeAudit } from "../ledger/events";
import { getAgent, requireAgent, requireWorkspace, type AgentRow } from "../ledger/workspace";

export const CONNECTOR_LABEL = "Free read-only MCP tool output: untrusted third-party data, not paid and not private.";

/** One approved connector as GET /marketplace/connectors reports it. Digests are recomputed here, not trusted. */
const catalogSchema = z.object({
  connectors: z.array(
    z.object({
      id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/),
      endpoint: z.string().max(300),
      risk: z.string(),
      tools: z.array(z.object({ name: z.string(), description: z.string(), inputSchema: z.record(z.string(), z.unknown()), sha256: z.string() })).max(32),
    }),
  ),
});
export type ConnectorCatalog = z.infer<typeof catalogSchema>["connectors"];

export function parseConnectorCatalog(body: unknown): ConnectorCatalog {
  const r = catalogSchema.safeParse(body);
  if (!r.success) throw new ControlError("PROVIDER_UNAVAILABLE", "the marketplace connector catalogue is malformed");
  return r.data.connectors;
}

interface PinnedTool {
  name: string;
  sha256: string;
  inputSchema: Record<string, unknown>;
  /** The approved description covered by the digest; attachments made before it was kept have none. */
  description?: string;
}

interface AttachmentRow {
  agent_id: string;
  connector_id: string;
  workspace_id: string;
  endpoint: string;
  tools_json: string;
  status: "active" | "changed";
  attached_at_ms: bigint;
  changed_at_ms: bigint | null;
}

const MAX_ARGS_BYTES = 4_096;
const MAX_STRING = 2_000;

/**
 * Arguments must be a flat object of keys the tool declares, with every required key present.
 * Values are bounded strings (or numbers, booleans and short string arrays where the schema
 * says so); nested objects are refused.
 */
export function connectorArgsProblem(args: unknown, inputSchema: Record<string, unknown>): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "arguments must be a JSON object";
  if (Buffer.byteLength(JSON.stringify(args)) > MAX_ARGS_BYTES) return "arguments are too large";
  const props = (typeof inputSchema.properties === "object" && inputSchema.properties !== null ? inputSchema.properties : {}) as Record<string, Record<string, unknown>>;
  const required = Array.isArray(inputSchema.required) ? inputSchema.required.filter((r): r is string => typeof r === "string") : [];
  for (const r of required) if (!(r in args)) return `required argument ${r} is missing`;
  for (const [k, v] of Object.entries(args)) {
    const p = Object.hasOwn(props, k) ? props[k] : undefined;
    if (!p || typeof p !== "object") return `argument ${k} is not in the tool's input schema`;
    const variants = Array.isArray(p.anyOf) ? (p.anyOf as Array<Record<string, unknown>>) : [p];
    const types = new Set(variants.map((x) => x.type).flat().filter((t): t is string => typeof t === "string"));
    if (types.size === 0) types.add("string");
    const strOk = (s: unknown) =>
      typeof s === "string" &&
      s.length <= Math.min(typeof p.maxLength === "number" ? p.maxLength : MAX_STRING, MAX_STRING) &&
      s.length >= (typeof p.minLength === "number" ? p.minLength : 0) &&
      (!Array.isArray(p.enum) || p.enum.includes(s));
    const ok =
      (types.has("string") && strOk(v)) ||
      ((types.has("number") || types.has("integer")) && typeof v === "number" && Number.isFinite(v) && (types.has("number") || Number.isInteger(v))) ||
      (types.has("boolean") && typeof v === "boolean") ||
      (types.has("array") && Array.isArray(v) && v.length <= 20 && v.every((x) => typeof x === "string" && x.length <= MAX_STRING));
    if (!ok) return `argument ${k} does not match the tool's input schema`;
  }
  return null;
}

export interface AgentConnectorsDeps {
  ledger: Ledger;
  /** Approved connectors from the marketplace; absent when MARKETPLACE_URL is unset. */
  catalog?: (() => Promise<ConnectorCatalog>) | undefined;
  client: (endpoint: string) => McpClient;
  limits: { perTask: number; perAgentDay: number; maxTextChars: number };
  log?: (line: string) => void;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Owner-attached, operator-approved, read-only MCP tools that a running task may call. Tools are
 * keyless and free: no x402 payment, no credentials and no policy, notes or keys reach them.
 */
export class AgentConnectors {
  constructor(readonly deps: AgentConnectorsDeps) {}

  #rows(agentId: string): AttachmentRow[] {
    return this.deps.ledger.db.prepare(`SELECT * FROM agent_connector WHERE agent_id = ? ORDER BY connector_id`).all(agentId) as AttachmentRow[];
  }

  list(workspaceId: string, agentId: string): { attached: Array<{ connectorId: string; tools: string[]; attachedAt: string; status: string }> } {
    const agent = requireAgent(this.deps.ledger, workspaceId, agentId);
    return {
      attached: this.#rows(agent.id).map((r) => ({
        connectorId: r.connector_id,
        tools: (JSON.parse(r.tools_json) as PinnedTool[]).map((t) => t.name),
        attachedAt: iso(r.attached_at_ms),
        status: r.status,
      })),
    };
  }

  /** What the runner may call: tool names, approved descriptions and input schemas only, never endpoints. */
  workerList(agent: AgentRow): {
    label: string;
    connectors: Array<{ connectorId: string; status: string; tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> }>;
  } {
    return {
      label: CONNECTOR_LABEL,
      connectors: this.#rows(agent.id).map((r) => ({
        connectorId: r.connector_id,
        status: r.status,
        tools: (JSON.parse(r.tools_json) as PinnedTool[]).map((t) => ({ name: t.name, ...(typeof t.description === "string" ? { description: t.description } : {}), inputSchema: t.inputSchema })),
      })),
    };
  }

  async attach(owner: { workspaceId: string; ownerPubkey: string }, agentId: string, connectorId: string, tools: string[]) {
    const { ledger } = this.deps;
    const assertAttachable = () => {
      const agent = requireAgent(ledger, owner.workspaceId, agentId);
      if (agent.status === "archived" || agent.status === "revoked") throw new ControlError("ACCOUNT_STOPPED", `agent is ${agent.status}`);
      return agent;
    };
    assertAttachable();
    if (!this.deps.catalog) throw new ControlError("NOT_READY", "agent connectors need the marketplace (MARKETPLACE_URL)");
    let catalog: ConnectorCatalog;
    try {
      catalog = await this.deps.catalog();
    } catch (error) {
      if (error instanceof ControlError) throw error;
      throw new ControlError("PROVIDER_UNAVAILABLE", "the marketplace connector catalogue is unavailable");
    }
    const c = catalog.find((x) => x.id === connectorId);
    if (!c) throw new ControlError("SERVICE_NOT_ALLOWED", "connector is not approved in the marketplace");
    if (c.risk !== "read_only") throw new ControlError("SERVICE_NOT_ALLOWED", "only read-only connectors can be attached");
    if (mcpEndpointProblem(c.endpoint)) throw new ControlError("SERVICE_NOT_ALLOWED", "connector endpoint is not a public https URL");
    const pins: PinnedTool[] = tools.map((name) => {
      const t = c.tools.find((x) => x.name === name);
      if (!t) throw new ControlError("INVALID_REQUEST", `tool ${name} is not in the approved connector`);
      const parsed = mcpToolPinSchema.safeParse({ name: t.name, description: t.description, inputSchema: t.inputSchema });
      if (!parsed.success || mcpToolDigest(parsed.data) !== t.sha256) throw new ControlError("SERVICE_NOT_ALLOWED", `tool ${name} does not match its approved digest`);
      return { name: t.name, sha256: t.sha256, inputSchema: t.inputSchema, description: parsed.data.description.slice(0, 1_000) };
    });
    immediate(ledger.db, () => {
      const agent = assertAttachable();
      const now = ledger.now();
      ledger.db
        .prepare(
          `INSERT INTO agent_connector (agent_id, connector_id, workspace_id, endpoint, tools_json, status, attached_by, attached_at_ms, changed_at_ms)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL)
           ON CONFLICT (agent_id, connector_id) DO UPDATE SET endpoint = excluded.endpoint, tools_json = excluded.tools_json,
             status = 'active', attached_by = excluded.attached_by, attached_at_ms = excluded.attached_at_ms, changed_at_ms = NULL`,
        )
        .run(agent.id, c.id, agent.workspace_id, c.endpoint, JSON.stringify(pins), owner.ownerPubkey, now);
      writeAudit(ledger, {
        workspaceId: agent.workspace_id,
        scope: `agent:${agent.id}`,
        actorType: "owner",
        actorId: owner.ownerPubkey,
        action: "connector.attach",
        policyResult: "allowed",
        details: { connectorId: c.id, tools: pins.map((p) => ({ name: p.name, sha256: p.sha256 })) },
      });
    });
    return this.list(owner.workspaceId, agentId).attached.find((a) => a.connectorId === c.id)!;
  }

  detach(owner: { workspaceId: string; ownerPubkey: string }, agentId: string, connectorId: string): void {
    const { ledger } = this.deps;
    const agent = requireAgent(ledger, owner.workspaceId, agentId);
    immediate(ledger.db, () => {
      const r = ledger.db.prepare(`DELETE FROM agent_connector WHERE agent_id = ? AND connector_id = ?`).run(agent.id, connectorId);
      if (r.changes === 0) throw new ControlError("NOT_FOUND", "connector is not attached to this agent");
      writeAudit(ledger, {
        workspaceId: agent.workspace_id,
        scope: `agent:${agent.id}`,
        actorType: "owner",
        actorId: owner.ownerPubkey,
        action: "connector.detach",
        policyResult: "allowed",
        details: { connectorId },
      });
    });
  }

  /** Refuses while the workspace emergency stop is set or the agent is not active. */
  #assertAuthority(agentId: string): AgentRow {
    const agent = getAgent(this.deps.ledger, agentId);
    if (!agent) throw new ControlError("NOT_FOUND", "agent not found");
    if (requireWorkspace(this.deps.ledger, agent.workspace_id).stopped === 1n) throw new ControlError("ACCOUNT_STOPPED", "workspace emergency stop is active");
    if (agent.status !== "active") throw new ControlError("ACCOUNT_STOPPED", `agent is ${agent.status}`);
    return agent;
  }

  async call(agentId: string, body: { taskId: string; connectorId: string; tool: string; args: Record<string, unknown> }) {
    const { ledger } = this.deps;
    const audit = (agent: AgentRow, policyResult: "allowed" | "denied", details: Record<string, unknown>, reasonCode: string | null = null) =>
      writeAudit(ledger, { workspaceId: agent.workspace_id, scope: `agent:${agent.id}`, actorType: "worker", actorId: agent.id, action: "connector.call", policyResult, reasonCode, details });
    const ref = { taskId: body.taskId, connectorId: body.connectorId, tool: body.tool };
    let reserved: { callId: string; endpoint: string; pin: PinnedTool; agent: AgentRow };
    try {
      reserved = immediate(ledger.db, () => {
        const agent = this.#assertAuthority(agentId);
        const task = ownTask(ledger, agent.id, body.taskId);
        assertTaskLive(ledger, task);
        const row = ledger.db.prepare(`SELECT * FROM agent_connector WHERE agent_id = ? AND connector_id = ?`).get(agent.id, body.connectorId) as AttachmentRow | undefined;
        if (!row) throw new ControlError("POLICY_DENIED", "connector is not attached to this agent");
        if (row.status === "changed") throw new ControlError("SERVICE_NOT_ALLOWED", "connector tools changed since they were attached; the owner must attach it again");
        const pin = (JSON.parse(row.tools_json) as PinnedTool[]).find((t) => t.name === body.tool);
        if (!pin) throw new ControlError("POLICY_DENIED", "tool is not attached to this agent");
        const problem = connectorArgsProblem(body.args, pin.inputSchema);
        if (problem) throw new ControlError("INVALID_REQUEST", problem);
        const perTask = num(ledger.db.prepare(`SELECT count(*) FROM agent_connector_call WHERE task_id = ?`).pluck().get(task.id));
        if (perTask >= this.deps.limits.perTask) throw new ControlError("BUDGET_EXCEEDED", "task connector-call limit reached");
        const since = ledger.now() - DAY_MS;
        const perAgent = num(ledger.db.prepare(`SELECT count(*) FROM agent_connector_call WHERE agent_id = ? AND created_at_ms > ?`).pluck().get(agent.id, since));
        if (perAgent >= this.deps.limits.perAgentDay) throw new ControlError("BUDGET_EXCEEDED", "agent connector-call limit for the last 24 hours reached");
        chargeToolCall(ledger, agent.id, task.id, `connector:${body.connectorId}/${body.tool}`);
        const callId = ledger.newId();
        ledger.db
          .prepare(
            `INSERT INTO agent_connector_call (id, workspace_id, agent_id, task_id, connector_id, tool, args_sha256, outcome, created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          )
          .run(callId, agent.workspace_id, agent.id, task.id, body.connectorId, body.tool, sha256(canonicalJson(body.args)), ledger.now());
        audit(agent, "allowed", { ...ref, callId });
        return { callId, endpoint: row.endpoint, pin, agent };
      });
    } catch (error) {
      const agent = getAgent(ledger, agentId);
      if (error instanceof ControlError && agent) audit(agent, "denied", ref, error.code);
      throw error;
    }

    const { callId, endpoint, pin, agent } = reserved;
    const finish = (outcome: "ok" | "tool_error" | "changed" | "failed", text?: string) =>
      ledger.db
        .prepare(`UPDATE agent_connector_call SET outcome = ?, result_sha256 = ?, result_chars = ?, finished_at_ms = ? WHERE id = ?`)
        .run(outcome, text === undefined ? null : sha256(text), text === undefined ? null : text.length, ledger.now(), callId);
    try {
      const r = await callPinnedTool(this.deps.client(endpoint), { toolName: pin.name, toolSha256: pin.sha256 }, body.args, {
        // The listing round trip is awaited, so stop and pause are checked again just before the call.
        beforeCall: () => void this.#assertAuthority(agent.id),
        maxChars: this.deps.limits.maxTextChars,
      });
      finish(r.isError ? "tool_error" : "ok", r.text);
      this.deps.log?.(`connector call ${callId} ${body.connectorId}/${pin.name} ${r.isError ? "tool_error" : "ok"} ${r.text.length} chars`);
      return {
        untrusted: true,
        label: CONNECTOR_LABEL,
        callId,
        connectorId: body.connectorId,
        tool: pin.name,
        isError: r.isError,
        citation: r.isError ? null : connectorCitation(body.connectorId, pin.name, callId),
        text: r.text,
      };
    } catch (error) {
      if (error instanceof McpError && error.code === "MANIFEST_CHANGED") {
        immediate(ledger.db, () => {
          finish("changed");
          ledger.db
            .prepare(`UPDATE agent_connector SET status = 'changed', changed_at_ms = ? WHERE agent_id = ? AND connector_id = ? AND status = 'active'`)
            .run(ledger.now(), agent.id, body.connectorId);
          audit(agent, "denied", { ...ref, callId }, "TOOL_CHANGED");
        });
        throw new ControlError("SERVICE_NOT_ALLOWED", "the connector's tool changed since it was attached; the owner must attach it again");
      }
      finish("failed");
      if (error instanceof ControlError) {
        audit(agent, "denied", { ...ref, callId }, error.code);
        throw error;
      }
      this.deps.log?.(`connector call ${callId} ${body.connectorId}/${pin.name} failed`);
      throw new ControlError("PROVIDER_UNAVAILABLE", error instanceof McpError ? `connector call failed: ${error.message}` : "connector call failed");
    }
  }
}

export function connectorLimitsFromEnv(env: NodeJS.ProcessEnv): AgentConnectorsDeps["limits"] {
  const int = (name: string, fallback: number, max: number) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    if (!/^[0-9]{1,6}$/.test(raw) || Number(raw) > max) throw new Error(`${name} must be a whole number from 0 to ${max}`);
    return Number(raw);
  };
  return {
    perTask: int("CONNECTOR_CALLS_PER_TASK", 5, 100),
    perAgentDay: int("CONNECTOR_CALLS_PER_AGENT_DAY", 50, 10_000),
    maxTextChars: int("CONNECTOR_MAX_TEXT_CHARS", 16_000, 64_000),
  };
}
