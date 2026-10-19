import { requestBounded } from "./transport";
export { isPublicAddress, requestBounded } from "./transport";
export type { Resolver, BoundedResponse } from "./transport";
import { mcpToolDigest, mcpToolPinSchema, renderArgs, type McpToolPin } from "@veilo/contracts/marketplace";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The pinned MCP tool a listing sells, as the marketplace reports it in the job view. */
export interface McpJobTool {
  connectorId: string;
  endpoint: string;
  toolName: string;
  toolSha256: string;
  argsTemplate: Record<string, unknown>;
}

export class McpError extends Error {
  constructor(
    readonly code: "PROVIDER_UNAVAILABLE" | "MANIFEST_CHANGED" | "PROVIDER_FAILED",
    message: string,
  ) {
    super(message);
  }
}

const PROTOCOL_VERSION = "2025-06-18";

/**
 * Minimal client for a remote streamable-HTTP MCP server. It only lists and calls tools, never
 * follows redirects, bounds every reply and accepts JSON or a single-response event stream.
 */
export class McpClient {
  readonly #fetch: FetchLike;
  #session: string | undefined;
  #id = 0;

  constructor(
    readonly endpoint: string,
    private readonly o: { fetch?: FetchLike; bearer?: string | undefined; timeoutMs?: number; maxBytes?: number; publicOnly?: boolean; clientName?: string } = {},
  ) {
    this.#fetch = o.fetch ?? (o.publicOnly ? (u, i) => publicFetch(u, i, { maxBytes: o.maxBytes, timeoutMs: o.timeoutMs }) : (u, i) => fetch(u, i));
  }

  async #post(body: Record<string, unknown>): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL_VERSION };
    if (this.#session) headers["mcp-session-id"] = this.#session;
    if (this.o.bearer) headers.authorization = `Bearer ${this.o.bearer}`;
    let res: Response;
    try {
      res = await this.#fetch(this.endpoint, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000) });
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError("PROVIDER_UNAVAILABLE", `MCP server unreachable: ${(error as Error).name}`);
    }
    const session = res.headers.get("mcp-session-id");
    if (session && /^[\x21-\x7e]{1,256}$/.test(session)) this.#session = session;
    if (!("id" in body)) return undefined;
    const text = await readBounded(res, this.o.maxBytes ?? 1_048_576);
    if (!res.ok) throw new McpError(res.status >= 500 || res.status === 429 ? "PROVIDER_UNAVAILABLE" : "PROVIDER_FAILED", `MCP server returned HTTP ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    const messages: unknown[] = [];
    if (type.includes("text/event-stream")) {
      for (const line of text.split(/\r?\n/)) if (line.startsWith("data:")) messages.push(JSON.parse(line.slice(5).trim()) as unknown);
    } else {
      messages.push(JSON.parse(text) as unknown);
    }
    const reply = messages.find((m) => (m as { id?: unknown }).id === body.id) as { result?: unknown; error?: { message?: unknown } } | undefined;
    if (!reply) throw new McpError("PROVIDER_FAILED", "MCP server sent no reply for the request");
    if (reply.error) throw new McpError("PROVIDER_FAILED", `MCP error: ${String(reply.error.message ?? "unknown").slice(0, 200)}`);
    return reply.result;
  }

  async #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.#id += 1;
    return this.#post({ jsonrpc: "2.0", id: this.#id, method, params });
  }

  async initialize(): Promise<void> {
    await this.#request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: this.o.clientName ?? "veilo-seller-host", version: "1.0.0" } });
    await this.#post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listTools(): Promise<McpToolPin[]> {
    const tools: McpToolPin[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const r = (await this.#request("tools/list", cursor ? { cursor } : {})) as { tools?: unknown[]; nextCursor?: unknown };
      for (const t of r?.tools ?? []) {
        const x = t as { name?: unknown; description?: unknown; inputSchema?: unknown };
        const parsed = mcpToolPinSchema.safeParse({ name: x.name, description: typeof x.description === "string" ? x.description : "", inputSchema: x.inputSchema ?? {} });
        if (parsed.success) tools.push(parsed.data);
      }
      if (typeof r?.nextCursor !== "string" || r.nextCursor === "") break;
      cursor = r.nextCursor;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; content: unknown[] }> {
    const r = (await this.#request("tools/call", { name, arguments: args })) as { isError?: unknown; content?: unknown };
    return { isError: r?.isError === true, content: Array.isArray(r?.content) ? r.content : [] };
  }
}

/** Reads at most `max` bytes, cancelling the stream as soon as the bound is passed. */
async function readBounded(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new McpError("PROVIDER_FAILED", "MCP reply exceeds the size bound");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new McpError("PROVIDER_FAILED", "MCP reply exceeds the size bound");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** HTTPS-only public MCP transport, with connection-bound DNS checks and bounded decoded replies. */
export const publicFetch = async (url: string, init: RequestInit = {}, bounds?: { maxBytes?: number | undefined; timeoutMs?: number | undefined }) => {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new McpError("PROVIDER_FAILED", "MCP endpoint must use https");
  try {
    const r = await requestBounded(u, { ...bounds, method: init.method, headers: Object.fromEntries(new Headers(init.headers)), body: typeof init.body === "string" ? init.body : undefined, signal: init.signal ?? undefined, rejectRedirects: true });
    return new Response(r.status === 204 || r.status === 304 ? null : new Uint8Array(r.body), { status: r.status, headers: r.headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "MCP transport failed";
    throw new McpError(/size bound|content encoding|redirects|non-public/.test(message) ? "PROVIDER_FAILED" : "PROVIDER_UNAVAILABLE", message);
  }
};

/** Reads the live tool and refuses unless it still matches the reviewed digest. */
export async function liveToolMatches(client: McpClient, tool: Pick<McpJobTool, "toolName" | "toolSha256">): Promise<void> {
  const live = (await client.listTools()).find((t) => t.name === tool.toolName);
  if (!live) throw new McpError("MANIFEST_CHANGED", "the pinned tool is no longer offered by the server");
  if (mcpToolDigest(live) !== tool.toolSha256) throw new McpError("MANIFEST_CHANGED", "the tool's name, description or input schema changed since review");
}

/**
 * Calls a pinned tool once with arguments the caller has already validated. Only text content is
 * kept and bounded; images, resources and links in the reply are dropped, never fetched.
 */
export async function callPinnedTool(
  client: McpClient,
  tool: Pick<McpJobTool, "toolName" | "toolSha256">,
  args: Record<string, unknown>,
  o: { beforeCall?: () => void; maxChars?: number } = {},
): Promise<{ isError: boolean; text: string }> {
  await client.initialize();
  await liveToolMatches(client, tool);
  o.beforeCall?.();
  const r = await client.callTool(tool.toolName, args);
  const texts = r.content.flatMap((c) => {
    const x = c as { type?: unknown; text?: unknown };
    return x.type === "text" && typeof x.text === "string" ? [x.text] : [];
  });
  return { isError: r.isError, text: texts.join("\n").slice(0, o.maxChars ?? 64_000) };
}

/** Runs a listing's pinned tool on one text input and returns its output as untrusted JSON data. */
export async function runMcpTool(client: McpClient, tool: McpJobTool, input: string, beforeCall: () => void = () => undefined): Promise<string> {
  const r = await callPinnedTool(client, tool, renderArgs(tool.argsTemplate, input), { beforeCall });
  if (r.isError) throw new McpError("PROVIDER_FAILED", "the MCP tool reported an error");
  return JSON.stringify({ untrusted: true, connector: tool.connectorId, tool: tool.toolName, text: r.text });
}
