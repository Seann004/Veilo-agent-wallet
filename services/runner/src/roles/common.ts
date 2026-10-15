import { computeRequestDigest } from "@veilo/contracts/gateway";
import { ToolDenied, type ControlClient, type ControlReply, type RunBounds } from "../control-client";

export interface CatalogItem {
  serviceId: string;
  service: string;
  bindingStatus: string;
  sku: string;
  paymentPath: "private_x402" | "prepaid_credits";
  price: { amount: string };
  usage: { amount: string };
}

export interface RoleContext {
  client: ControlClient;
  taskId: string;
  agentId: string;
  // Task input is validated by control; roles read only the fields they need.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  task: any;
  bounds: RunBounds;
  now: () => number;
  notes: string[];
}

export interface RoleOutcome {
  taskState: "completed" | "incomplete" | "failed";
  summary: Record<string, unknown>;
}

export async function tool(ctx: RoleContext, name: string, args: Record<string, unknown> = {}): Promise<ControlReply> {
  return ctx.client.tool(name, args, { taskId: ctx.taskId, bounds: ctx.bounds, now: ctx.now });
}

/** Runs a tool and converts runner-side denials into a reply instead of an exception. */
export async function tryTool(ctx: RoleContext, name: string, args: Record<string, unknown> = {}): Promise<ControlReply> {
  try {
    return await tool(ctx, name, args);
  } catch (error) {
    if (error instanceof ToolDenied) return { status: 0, body: { error: { code: error.code, message: error.message } } };
    throw error;
  }
}

export async function buy(
  ctx: RoleContext,
  item: CatalogItem,
  key: string,
  input: Record<string, unknown>,
  rationale: string,
): Promise<ControlReply> {
  const name = item.paymentPath === "prepaid_credits" ? "consume_inference_sku" : "request_purchase";
  return tryTool(ctx, name, {
    idempotencyKey: `task:${ctx.taskId}:${key}`,
    serviceId: item.serviceId,
    sku: item.sku,
    requestDigest: computeRequestDigest(item.sku, input),
    input,
    rationale,
  });
}

export function delivered(r: ControlReply): boolean {
  return r.body?.purchase?.states?.fulfilment === "delivered";
}

/** Describes a purchase outcome for the artifact without collapsing unknown into failure. */
export function outcomeText(r: ControlReply): string {
  if (r.body?.purchase) {
    const blocked = r.body.execution?.blocked;
    return `${r.body.purchase.label}${blocked ? ` (${blocked.code}: ${blocked.message})` : ""}`;
  }
  return `not purchased (${r.body?.error?.code ?? `HTTP ${r.status}`}: ${r.body?.error?.message ?? "no detail"})`;
}

/** Extracts the first JSON object from model text; returns undefined when there is none. */
export function parseJsonObject(text: unknown): Record<string, unknown> | undefined {
  if (typeof text !== "string") return undefined;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const v = JSON.parse(text.slice(start, end + 1)) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sponsored planning call. Returns model text, or undefined with a visible note when planning
 * is unavailable, uncertain or exhausted; the runner never retries past its planning bound.
 */
export async function plan(ctx: RoleContext, purpose: string, system: string, user: string): Promise<string | undefined> {
  const r = await ctx.client.planning(ctx.taskId, purpose, [
    { role: "system", content: system },
    { role: "user", content: user.slice(0, 12_000) },
  ], ctx.bounds);
  if (r === null) {
    ctx.notes.push(`Planning skipped for "${purpose}": task planning-call limit reached.`);
    return undefined;
  }
  const outcome = r.body?.gateway?.outcome;
  if (r.status === 200 && outcome?.status === "succeeded" && typeof outcome.text === "string") return outcome.text;
  const code = r.body?.error?.code ?? r.body?.gateway?.error?.code ?? outcome?.code ?? outcome?.status ?? `HTTP ${r.status}`;
  ctx.notes.push(`Operator-sponsored planning unavailable for "${purpose}" (${code}); a deterministic plan was used and the call was not retried.`);
  return undefined;
}

/**
 * Executes planner-proposed tool calls. They pass through the same restricted executor and
 * control's independent checks as any other request; refusals are recorded, not retried.
 */
export async function runProposedCalls(ctx: RoleContext, proposed: unknown, maxCalls: number): Promise<Array<{ tool: string; outcome: string }>> {
  if (!Array.isArray(proposed)) return [];
  const results: Array<{ tool: string; outcome: string }> = [];
  for (const p of proposed.slice(0, maxCalls)) {
    const name = typeof p?.tool === "string" ? p.tool : "(invalid)";
    const args = p?.args !== null && typeof p?.args === "object" ? (p.args as Record<string, unknown>) : {};
    const r = await tryTool(ctx, name, args);
    results.push({ tool: name, outcome: r.status >= 200 && r.status < 300 ? `HTTP ${r.status}` : `refused: ${r.body?.error?.code ?? r.status}` });
  }
  return results;
}

const URL_IN_TEXT = /\b(?:https?|fixture|file|ftp):\/\/[^\s)\]>"']+/g;

/** Removes URLs that are not purchased evidence from service or model text. */
export function stripUnlistedUrls(text: string, allowed: ReadonlySet<string>): { text: string; removed: number } {
  let removed = 0;
  const out = text.replace(URL_IN_TEXT, (u) => {
    if (allowed.has(u)) return u;
    removed += 1;
    return "[link removed: not purchased evidence]";
  });
  return { text: out, removed };
}
