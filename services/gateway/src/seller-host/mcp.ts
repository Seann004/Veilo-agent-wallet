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
    private readonly o: { fetch?: FetchLike; bearer?: string | undefined; timeoutMs?: number; maxBytes?: number } = {},
  ) {
    this.#fetch = o.fetch ?? ((u, i) => fetch(u, i));
  }

  async #post(body: Record<string, unknown>): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL_VERSION };
    if (this.#session) headers["mcp-session-id"] = this.#session;
    if (this.o.bearer) headers.authorization = `Bearer ${this.o.bearer}`;
    let res: Response;
    try {
      res = await this.#fetch(this.endpoint, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000) });
    } catch (error) {
      throw new McpError("PROVIDER_UNAVAILABLE", `MCP server unreachable: ${(error as Error).name}`);
    }
    const session = res.headers.get("mcp-session-id");
    if (session && /^[\x21-\x7e]{1,256}$/.test(session)) this.#session = session;
    if (!("id" in body)) return undefined;
    const text = await res.text();
    if (Buffer.byteLength(text) > (this.o.maxBytes ?? 1_048_576)) throw new McpError("PROVIDER_FAILED", "MCP reply exceeds the size bound");
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
    await this.#request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "veilo-seller-host", version: "1.0.0" } });
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

/** Reads the live tool and refuses unless it still matches the reviewed digest. */
export async function liveToolMatches(client: McpClient, tool: Pick<McpJobTool, "toolName" | "toolSha256">): Promise<void> {
  const live = (await client.listTools()).find((t) => t.name === tool.toolName);
  if (!live) throw new McpError("MANIFEST_CHANGED", "the pinned tool is no longer offered by the server");
  if (mcpToolDigest(live) !== tool.toolSha256) throw new McpError("MANIFEST_CHANGED", "the tool's name, description or input schema changed since review");
}

/**
 * Calls a pinned tool once. Only text content is kept, bounded, and returned as data; images,
 * resources and links in the reply are dropped, never fetched.
 */
export async function runMcpTool(client: McpClient, tool: McpJobTool, input: string, beforeCall: () => void = () => undefined): Promise<string> {
  await client.initialize();
  await liveToolMatches(client, tool);
  beforeCall();
  const r = await client.callTool(tool.toolName, renderArgs(tool.argsTemplate, input));
  if (r.isError) throw new McpError("PROVIDER_FAILED", "the MCP tool reported an error");
  const texts = r.content.flatMap((c) => {
    const x = c as { type?: unknown; text?: unknown };
    return x.type === "text" && typeof x.text === "string" ? [x.text] : [];
  });
  return JSON.stringify({ untrusted: true, connector: tool.connectorId, tool: tool.toolName, text: texts.join("\n").slice(0, 64_000) });
}

/** Endpoints this host may contact, from its own configuration; bearer tokens stay in this process. */
export function mcpConfigFromEnv(env: NodeJS.ProcessEnv): { endpoints: ReadonlySet<string>; bearerFor: (connectorId: string) => string | undefined } {
  const endpoints = new Set((env.SELLER_HOST_MCP_ENDPOINTS ?? "").split(",").map((x) => x.trim()).filter((x) => x !== ""));
  return {
    endpoints,
    bearerFor: (id) => env[`MCP_BEARER_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`]?.trim() || undefined,
  };
}
