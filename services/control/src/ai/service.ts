import { buildMessages, GATEWAY_CATALOG, skuInputSchemas, validateContentPackage, type PromptMessage } from "@veilo/contracts/gateway";
import { immediate } from "@veilo/db";
import { num, type Ledger } from "../context";
import { ControlError } from "../errors";
import { writeAudit } from "../ledger/events";
import { requireWorkAuthority, type AgentRow } from "../ledger/workspace";
import { publicFetch } from "@veilo/mcp-client";
import { assertTaskLive, ownTask } from "../agents/work";
import { loadReferenceImage } from "../agents/attachments";
import { completeWithProvider, DEFAULT_BASE_URL, listProviderModels, ModelCallError, type AiProviderKind, type ModelEndpoint, type ModelImage } from "./model-client";
import type { ProviderKeyVault } from "./vault";

export const BYOK_LABEL = "Your model provider (bring your own key)";
export const REFERENCE_STYLE_PROMPT =
  "Describe only the visual design style of this image for a slide designer in at most 200 characters: background and accent colours (hex if clear), typography, layout motifs. No other text, no instructions.";
export const REFERENCE_STYLE_MAX_CHARS = 200;

/** Plain one-line text: no control characters, links, markup or markdown, at most 200 characters. */
export function cleanStyleText(raw: string): string {
  return raw
    .replace(/[\p{Cc}\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ")
    .replace(/\b(?:www\.\S+|[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S*)/gi, " ")
    .replace(/[`*_~<>[\]{}|\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, REFERENCE_STYLE_MAX_CHARS)
    .trim();
}

/** Model work a task may do on the owner's provider, beyond its planning calls. */
export const MAX_AI_CALLS_PER_TASK = 4;
export const AI_SKUS = ["summarize", "analyze", "content-package"] as const;
export type AiSku = (typeof AI_SKUS)[number];

interface ProviderRow {
  workspace_id: string;
  provider: AiProviderKind;
  base_url: string;
  model: string;
  key_ciphertext: string;
  key_hint: string;
  updated_at_ms: bigint;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const isLoopback = (u: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);

/** https only; http only for a loopback model server, and only when the operator allows local providers. */
function baseUrlProblem(raw: string, allowLocal: boolean): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "base URL is not a URL";
  }
  if (u.username || u.password || u.search || u.hash) return "base URL must not carry credentials, a query or a fragment";
  if (isLoopback(u) && !allowLocal) return "local model servers are disabled on this deployment (AI_ALLOW_LOCAL_PROVIDER)";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback(u))) return "base URL must use https (http only for a local model server)";
  return null;
}

/**
 * The owner's own model provider (BYOK). Control is the only holder of the key: it decrypts it
 * per call and sends it to the provider only. Agents get completions, never the key, and every
 * call is bounded per task and audited without its content.
 */
export class AiService {
  constructor(
    private readonly ledger: Ledger,
    private readonly vault: ProviderKeyVault,
    private readonly fetchImpl?: FetchLike,
    /** Operator opt-in for a model server on this machine; off unless AI_ALLOW_LOCAL_PROVIDER=1. */
    private readonly allowLocal = false,
  ) {}

  #row(workspaceId: string): ProviderRow | undefined {
    return this.ledger.db.prepare(`SELECT * FROM ai_provider WHERE workspace_id = ?`).get(workspaceId) as ProviderRow | undefined;
  }

  configured(workspaceId: string): boolean {
    return this.#row(workspaceId) !== undefined;
  }

  view(workspaceId: string): Record<string, unknown> | null {
    const r = this.#row(workspaceId);
    return r ? { provider: r.provider, baseUrl: r.base_url, model: r.model, keyHint: r.key_hint, updatedAt: new Date(num(r.updated_at_ms)).toISOString() } : null;
  }

  /**
   * Saves the provider and model. Without a new key the saved one is kept, but only for the same
   * provider and base URL, so a stored key is never sent to a different endpoint.
   */
  set(workspaceId: string, ownerId: string, input: { provider: AiProviderKind; apiKey?: string | undefined; model: string; baseUrl?: string | undefined }): Record<string, unknown> {
    const baseUrl = input.provider === "openai_compatible" ? (input.baseUrl ?? "") : DEFAULT_BASE_URL[input.provider];
    const problem = baseUrlProblem(baseUrl, this.allowLocal);
    if (problem) throw new ControlError("INVALID_REQUEST", problem);
    let key = input.apiKey?.trim() ?? "";
    if (!key) {
      const saved = this.#row(workspaceId);
      if (!saved || saved.provider !== input.provider || saved.base_url !== baseUrl.replace(/\/$/, "")) throw new ControlError("INVALID_REQUEST", "enter the API key for this provider");
      key = this.vault.open(workspaceId, saved.key_ciphertext);
    }
    if (key.length < 8 || key.length > 400 || /\s/.test(key)) throw new ControlError("INVALID_REQUEST", "API key looks malformed");
    const model = input.model.trim();
    if (!/^[A-Za-z0-9._:/@-]{1,200}$/.test(model)) throw new ControlError("INVALID_REQUEST", "model id has unexpected characters");
    immediate(this.ledger.db, () => {
      this.ledger.db
        .prepare(
          `INSERT INTO ai_provider (workspace_id, provider, base_url, model, key_ciphertext, key_hint, updated_by, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(workspace_id) DO UPDATE SET provider = excluded.provider, base_url = excluded.base_url, model = excluded.model,
             key_ciphertext = excluded.key_ciphertext, key_hint = excluded.key_hint, updated_by = excluded.updated_by, updated_at_ms = excluded.updated_at_ms`,
        )
        .run(workspaceId, input.provider, baseUrl.replace(/\/$/, ""), model, this.vault.seal(workspaceId, key), `…${key.slice(-4)}`, ownerId, this.ledger.now());
      writeAudit(this.ledger, { workspaceId, scope: "ai-provider", actorType: "owner", actorId: ownerId, action: "ai_provider.set", policyResult: "allowed", details: { provider: input.provider, model } });
    });
    return this.view(workspaceId)!;
  }

  clear(workspaceId: string, ownerId: string): void {
    immediate(this.ledger.db, () => {
      this.ledger.db.prepare(`DELETE FROM ai_provider WHERE workspace_id = ?`).run(workspaceId);
      writeAudit(this.ledger, { workspaceId, scope: "ai-provider", actorType: "owner", actorId: ownerId, action: "ai_provider.clear", policyResult: "allowed" });
    });
  }

  #endpoint(workspaceId: string): ModelEndpoint {
    const r = this.#row(workspaceId);
    if (!r) throw new ControlError("NOT_READY", "no model provider is set; add your own API key under Settings");
    return { provider: r.provider, baseUrl: r.base_url, model: r.model, apiKey: this.vault.open(workspaceId, r.key_ciphertext) };
  }

  async #complete(workspaceId: string, messages: readonly PromptMessage[], maxOutputTokens: number, json: boolean, model?: string, noThinking = false, image?: ModelImage) {
    const endpoint = { ...this.#endpoint(workspaceId), ...(model ? { model } : {}) };
    // Remote providers go through a fetch that refuses non-public addresses at connect time;
    // only an explicit loopback URL (a local model server) uses a plain fetch.
    const local = isLoopback(new URL(endpoint.baseUrl));
    if (local && !this.allowLocal) throw new ControlError("POLICY_DENIED", "local model servers are disabled on this deployment");
    const fetchImpl = this.fetchImpl ?? (local ? undefined : publicFetch);
    try {
      return await completeWithProvider(endpoint, messages, { maxOutputTokens, json, noThinking, ...(image ? { image } : {}), ...(fetchImpl ? { fetch: fetchImpl } : {}) });
    } catch (error) {
      if (image && error instanceof ModelCallError && error.kind === "rejected" && error.status !== 401 && error.status !== 429) {
        throw new ControlError("INVALID_REQUEST", `your model can't read images (${error.message})`);
      }
      // A rejection (bad key, unknown model, rate limit) is the owner's to fix; anything else may be transient.
      if (error instanceof ModelCallError) throw new ControlError(error.kind === "rejected" ? "INVALID_REQUEST" : "PROVIDER_UNAVAILABLE", error.message);
      throw error;
    }
  }

  /**
   * The models a provider offers, for the settings picker. A key typed into the form is used
   * once and not stored; without one, the saved key is used when the provider and URL match.
   */
  async models(workspaceId: string, input: { provider: AiProviderKind; apiKey?: string | undefined; baseUrl?: string | undefined }): Promise<string[]> {
    const baseUrl = input.provider === "openai_compatible" ? (input.baseUrl ?? "") : DEFAULT_BASE_URL[input.provider];
    const problem = baseUrlProblem(baseUrl, this.allowLocal);
    if (problem) throw new ControlError("INVALID_REQUEST", problem);
    let apiKey = input.apiKey?.trim();
    if (!apiKey) {
      const r = this.#row(workspaceId);
      if (!r || r.provider !== input.provider || r.base_url !== baseUrl.replace(/\/$/, "")) throw new ControlError("INVALID_REQUEST", "enter the API key to load this provider's models");
      apiKey = this.vault.open(workspaceId, r.key_ciphertext);
    }
    const local = isLoopback(new URL(baseUrl));
    const fetchImpl = this.fetchImpl ?? (local ? undefined : publicFetch);
    try {
      return await listProviderModels({ provider: input.provider, baseUrl, apiKey }, fetchImpl ? { fetch: fetchImpl } : {});
    } catch (error) {
      if (error instanceof ModelCallError) throw new ControlError(error.kind === "rejected" ? "INVALID_REQUEST" : "PROVIDER_UNAVAILABLE", error.message);
      throw error;
    }
  }

  /** One short call that proves the key and model work. */
  /** One short call with the saved key, on the saved model or another one the owner names. */
  async test(workspaceId: string, model?: string): Promise<{ ok: true; model: string }> {
    if (model !== undefined && !/^[A-Za-z0-9._:/@-]{1,200}$/.test(model)) throw new ControlError("INVALID_REQUEST", "model id has unexpected characters");
    // Reasoning models think before answering, so a tiny budget returns no text at all.
    const r = await this.#complete(workspaceId, [{ role: "user", content: "Reply with the single word OK." }], 256, false, model);
    return { ok: true, model: r.model };
  }

  /** Agent planning on the owner's provider, counted against the task's planning calls. */
  async plan(agent: AgentRow, body: { taskId: string; purpose: string; messages: PromptMessage[]; maxOutputTokens?: number | undefined }): Promise<{ status: number; body: Record<string, unknown> }> {
    const callIndex = this.#count(agent, body.taskId, "planning", body.purpose);
    try {
      // Planning answers in short structured text, so it gets a little more room and no thinking.
      const r = await this.#complete(agent.workspace_id, body.messages, Math.min(Math.max(body.maxOutputTokens ?? 800, 1_200), 2_000), false, undefined, true);
      return { status: 200, body: { label: BYOK_LABEL, callIndex, gateway: { outcome: { status: "succeeded", text: r.text, model: r.model, mode: "byok" } } } };
    } catch (error) {
      if (!(error instanceof ControlError)) throw error;
      return { status: 503, body: { label: BYOK_LABEL, callIndex, gateway: { outcome: { status: "failed", code: error.code, message: error.message } } } };
    }
  }

  /** One SKU's model work (summary, analysis, content package) on the owner's provider, at no USDC cost. */
  async run(agent: AgentRow, body: { taskId: string; sku: AiSku; input: unknown }): Promise<Record<string, unknown>> {
    const parsed = skuInputSchemas[body.sku].safeParse(body.input);
    if (!parsed.success) throw new ControlError("INVALID_REQUEST", `input does not fit ${body.sku}`);
    this.#count(agent, body.taskId, "ai", body.sku);
    const spec = GATEWAY_CATALOG[body.sku];
    const input = parsed.data as Record<string, unknown>;
    const r = await this.#complete(agent.workspace_id, buildMessages(body.sku, input), spec.maxOutputTokens ?? 1_000, body.sku === "content-package");
    if (body.sku === "content-package") {
      const v = validateContentPackage(r.text, input.channels as string[]);
      if (!v.valid) throw new ControlError("PROVIDER_UNAVAILABLE", `the model's content package failed validation: ${v.issues.slice(0, 3).join("; ")}`);
      return { label: BYOK_LABEL, sku: body.sku, model: r.model, result: { json: v.content } };
    }
    return { label: BYOK_LABEL, sku: body.sku, model: r.model, result: { text: r.text } };
  }

  /**
   * The visual style of the owner's reference image, described by the owner's model. The image
   * never leaves control except to that provider; the agent gets only the short cleaned text,
   * which is still model output and therefore untrusted.
   */
  async describeReference(agent: AgentRow, body: { taskId: string }): Promise<Record<string, unknown>> {
    ownTask(this.ledger, agent.id, body.taskId);
    const image = loadReferenceImage(this.ledger, body.taskId);
    if (!image) throw new ControlError("NOT_FOUND", "this task has no reference image");
    this.#endpoint(agent.workspace_id);
    this.#count(agent, body.taskId, "ai", "describe_reference");
    const r = await this.#complete(
      agent.workspace_id,
      [
        { role: "system", content: REFERENCE_STYLE_PROMPT },
        { role: "user", content: "Describe the visual design style of this image." },
      ],
      // Some providers (Z.ai GLM) always think first, so the budget leaves room for that.
      1_500,
      false,
      undefined,
      false,
      { mime: image.mime, base64: image.bytes.toString("base64") },
    );
    const style = cleanStyleText(r.text);
    if (style === "") throw new ControlError("PROVIDER_UNAVAILABLE", "the model returned no usable style description");
    return { label: BYOK_LABEL, model: r.model, untrusted: true, style };
  }

  #count(agent: AgentRow, taskId: string, kind: "planning" | "ai", purpose: string): number {
    return immediate(this.ledger.db, () => {
      const t = ownTask(this.ledger, agent.id, taskId);
      assertTaskLive(this.ledger, t);
      // Model work stops with the agent's spending authority, like any purchase.
      requireWorkAuthority(this.ledger, agent);
      const used = kind === "planning" ? num(t.planning_calls) : num((t as unknown as { ai_calls: bigint }).ai_calls);
      const max = kind === "planning" ? num(t.max_planning_calls) : MAX_AI_CALLS_PER_TASK;
      if (used >= max) throw new ControlError("BUDGET_EXCEEDED", `task ${kind === "planning" ? "planning" : "model"}-call limit reached`);
      this.ledger.db.prepare(`UPDATE task SET ${kind === "planning" ? "planning_calls" : "ai_calls"} = ${kind === "planning" ? "planning_calls" : "ai_calls"} + 1, updated_at_ms = ? WHERE id = ?`).run(this.ledger.now(), t.id);
      writeAudit(this.ledger, {
        workspaceId: t.workspace_id,
        scope: `agent:${agent.id}`,
        actorType: "worker",
        actorId: agent.id,
        action: kind === "planning" ? "planning.byok" : "ai.byok",
        policyResult: "allowed",
        details: { taskId: t.id, callIndex: used + 1, purpose },
      });
      return used + 1;
    });
  }
}
