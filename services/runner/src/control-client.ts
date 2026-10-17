import { AGENT_TOOLS, CUSTOM_AGENT_TOOLS, type AgentToolDefinition } from "@veilo/contracts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ControlReply {
  status: number;
  // Control replies are read field by field by the role code.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/** A tool request that was refused by the runner itself, before reaching control. */
export class ToolDenied extends Error {
  constructor(
    readonly code: "TOOL_UNAVAILABLE" | "INVALID_TOOL_ARGUMENTS" | "BUDGET_EXCEEDED",
    message: string,
  ) {
    super(message);
    this.name = "ToolDenied";
  }
}

export interface RunBounds {
  maxToolCalls: number;
  maxPaidPurchases: number;
  maxPlanningCalls: number;
  deadlineMs: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Fields each tool may receive; anything else (destinations, agent IDs, policy fields) is dropped
// before the request is built, and control validates the result again with strict schemas.
const ALLOWED_ARGS: Record<string, readonly string[]> = {
  catalog_lookup: [],
  budget_summary: [],
  request_purchase: ["idempotencyKey", "serviceId", "sku", "requestDigest", "taskId", "rationale", "input"],
  consume_inference_sku: ["idempotencyKey", "serviceId", "sku", "requestDigest", "taskId", "rationale", "input"],
  purchase_status: ["id"],
  run_ai: ["taskId", "sku", "input"],
  save_artifact: ["taskId", "kind", "title", "content", "citations", "sourcePurchaseIds", "artifactId"],
  request_handoff: ["artifactId", "toAgentId", "note"],
  marketplace_search: ["q"],
  // No recipient, price, agent or policy field exists here: the quote and local authorization decide those.
  propose_hire: ["taskId", "listingId", "brief", "idempotencyKey"],
};

/**
 * The runner's only path to control. Model-facing actions go through `tool`, which accepts
 * exactly the names in AGENT_TOOLS, strips unknown arguments and injects fixed fields. The
 * remaining methods are runner infrastructure (leases, task reads, sponsored planning).
 */
export class ControlClient {
  readonly #base: string;
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #tools: readonly AgentToolDefinition[];
  toolCalls = 0;
  paidRequests = 0;
  planningCalls = 0;
  readonly denied: Array<{ tool: string; code: string; message: string }> = [];

  constructor(o: { baseUrl: string; token: string; fetch?: FetchLike; customTools?: boolean }) {
    this.#base = o.baseUrl.replace(/\/$/, "");
    this.#token = o.token;
    this.#fetch = o.fetch ?? ((i, init) => fetch(i, init));
    this.#tools = o.customTools ? [...AGENT_TOOLS, ...CUSTOM_AGENT_TOOLS] : AGENT_TOOLS;
  }

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ControlReply> {
    const res = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.#token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(180_000),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return { status: res.status, body: parsed };
  }

  /** Executes one agent tool under the run bounds. Unknown tools never reach the network. */
  async tool(name: string, args: Record<string, unknown>, ctx: { taskId: string; bounds: RunBounds; now: () => number }): Promise<ControlReply> {
    const deny = (code: ToolDenied["code"], message: string): never => {
      this.denied.push({ tool: name, code, message });
      throw new ToolDenied(code, message);
    };
    const def = this.#tools.find((t) => t.name === name);
    if (!def) return deny("TOOL_UNAVAILABLE", `tool ${name} is not available to this agent`);
    if (ctx.now() > ctx.bounds.deadlineMs) deny("BUDGET_EXCEEDED", "task duration bound reached");
    if (this.toolCalls >= ctx.bounds.maxToolCalls) deny("BUDGET_EXCEEDED", "task tool-call limit reached");
    // A hire proposal can lead to a payment, so it counts against the paid-purchase bound too.
    const paid = name === "request_purchase" || name === "consume_inference_sku" || name === "propose_hire";
    if (paid && this.paidRequests >= ctx.bounds.maxPaidPurchases) deny("BUDGET_EXCEEDED", "task paid-purchase limit reached");

    const allowed = ALLOWED_ARGS[name] ?? [];
    const clean: Record<string, unknown> = {};
    for (const k of allowed) if (args[k] !== undefined) clean[k] = args[k];
    for (const [k, v] of Object.entries(def.fixed ?? {})) clean[k] = v;
    if ("taskId" in clean || allowed.includes("taskId")) clean.taskId = ctx.taskId;

    let path = def.path;
    if (path.includes(":id")) {
      const id = String(clean.id ?? "");
      if (!UUID.test(id)) deny("INVALID_TOOL_ARGUMENTS", "resource id must be a UUID");
      path = path.replace(":id", id);
      delete clean.id;
    }
    this.toolCalls += 1;
    if (paid) this.paidRequests += 1;
    if (def.method === "GET" && Object.keys(clean).length > 0) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(clean)) qs.set(k, String(v));
      path = `${path}?${qs.toString()}`;
    }
    return this.request(def.method, path, def.method === "GET" ? undefined : clean, { "x-veilo-task-id": ctx.taskId });
  }

  /** Approved read-only connectors the owner attached to this agent: tool names and input schemas only. */
  connectors(): Promise<ControlReply> {
    return this.request("GET", "/worker/connectors");
  }

  /**
   * One free read-only connector call. It is not a model tool, but it counts against the task's
   * tool-call bound like one; control applies its own per-task and per-agent caps on top.
   */
  async connectorCall(taskId: string, call: { connectorId: string; tool: string; args: Record<string, unknown> }, ctx: { bounds: RunBounds; now: () => number }): Promise<ControlReply> {
    const deny = (message: string): never => {
      this.denied.push({ tool: "connector_call", code: "BUDGET_EXCEEDED", message });
      throw new ToolDenied("BUDGET_EXCEEDED", message);
    };
    if (ctx.now() > ctx.bounds.deadlineMs) deny("task duration bound reached");
    if (this.toolCalls >= ctx.bounds.maxToolCalls) deny("task tool-call limit reached");
    this.toolCalls += 1;
    return this.request("POST", "/worker/connector-calls", { taskId, connectorId: call.connectorId, tool: call.tool, args: call.args });
  }

  claim(workerId: string, leaseMs: number): Promise<ControlReply> {
    return this.request("POST", "/worker/jobs/claim", { workerId, leaseMs });
  }

  heartbeat(jobId: string, workerId: string, version: string, leaseMs: number): Promise<ControlReply> {
    return this.request("POST", `/worker/jobs/${jobId}/heartbeat`, { workerId, version, leaseMs });
  }

  complete(jobId: string, body: { workerId: string; version: string; outcome: "completed" | "failed"; taskState: "completed" | "incomplete" | "failed"; result: Record<string, unknown> }): Promise<ControlReply> {
    return this.request("POST", `/worker/jobs/${jobId}/complete`, body);
  }

  task(taskId: string): Promise<ControlReply> {
    return this.request("GET", `/worker/tasks/${taskId}`);
  }

  async planning(taskId: string, purpose: string, messages: Array<{ role: "system" | "user"; content: string }>, bounds: RunBounds): Promise<ControlReply | null> {
    if (this.planningCalls >= bounds.maxPlanningCalls) return null;
    this.planningCalls += 1;
    return this.request("POST", "/worker/planning", { taskId, purpose, messages, maxOutputTokens: 600 });
  }
}
