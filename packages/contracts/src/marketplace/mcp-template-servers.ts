import { mcpToolDigest, type McpToolPin } from "./mcp";
import { codeExecutionToolProblem, mcpTemplate, templatedToolPin } from "./mcp-templates";

/**
 * A public MCP server for which Veilo ships fixed templates. A connector for it offers exactly the
 * listed read-only tools as the server lists them, plus the templates pinned to the server's live
 * code tool. The code tool itself is never offered.
 */
export interface McpTemplateServer {
  /** Connector id a proposal for this server uses. */
  id: string;
  title: string;
  endpoint: string;
  host: string;
  /** Live tools offered as listed; each must be keyless and read-only. */
  readOnlyTools: readonly string[];
  templates: readonly string[];
  /** Shown to the owner when proposing and kept as the operator's approval note. */
  explanation: string;
}

export const MCP_TEMPLATE_SERVERS: readonly McpTemplateServer[] = [
  {
    id: "coingecko-market",
    title: "CoinGecko market data",
    endpoint: "https://mcp.api.coingecko.com/mcp",
    host: "mcp.api.coingecko.com",
    readOnlyTools: ["search_docs"],
    templates: ["coingecko_simple_price", "coingecko_trending", "coingecko_search"],
    explanation: "Veilo runs fixed CoinGecko queries; agents fill in only coin ids, currencies or a search term, never code.",
  },
];

for (const s of MCP_TEMPLATE_SERVERS) {
  for (const n of s.templates) if (mcpTemplate(n)?.host !== s.host) throw new Error(`template ${n} does not run on ${s.host}`);
}

/** The template server for an endpoint's host, or undefined. Calls always go to the server's own endpoint. */
export function mcpTemplateServerFor(endpoint: string): McpTemplateServer | undefined {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return undefined;
  return MCP_TEMPLATE_SERVERS.find((s) => s.host === u.hostname.toLowerCase());
}

export function mcpTemplateServer(id: string): McpTemplateServer | undefined {
  return MCP_TEMPLATE_SERVERS.find((s) => s.id === id);
}

export interface TemplateServerTools {
  /** What a proposal for this server carries, in a stable order: read-only tools, then templates. */
  tools: McpToolPin[];
  /** Live tools that are not offered, with the reason. */
  omitted: Array<{ name: string; reason: string }>;
  /** Tools the server should list but does not; a proposal is incomplete while any are missing. */
  missing: string[];
}

/** Builds the connector's tools from the server's live tools/list. */
export function templateServerTools(server: McpTemplateServer, live: readonly McpToolPin[]): TemplateServerTools {
  const byName = new Map(live.map((t) => [t.name, t]));
  const upstreams = new Set(server.templates.map((n) => mcpTemplate(n)!.upstream));
  const tools: McpToolPin[] = [];
  const omitted: TemplateServerTools["omitted"] = [];
  const missing: string[] = [];
  for (const t of live) {
    if (codeExecutionToolProblem(t)) {
      omitted.push({ name: t.name, reason: upstreams.has(t.name) ? "runs caller-supplied code; Veilo offers its fixed queries instead" : "runs caller-supplied code" });
    } else if (!server.readOnlyTools.includes(t.name)) {
      omitted.push({ name: t.name, reason: "not on Veilo's reviewed list for this server" });
    }
  }
  for (const name of server.readOnlyTools) {
    const t = byName.get(name);
    if (!t || codeExecutionToolProblem(t)) missing.push(name);
    else tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
  }
  for (const name of server.templates) {
    const upstream = byName.get(mcpTemplate(name)!.upstream);
    if (!upstream) missing.push(mcpTemplate(name)!.upstream);
    else tools.push(templatedToolPin(name, mcpToolDigest(upstream)));
  }
  return { tools, omitted, missing: [...new Set(missing)] };
}

/**
 * Compares a proposal's tools with what the live server implies now. Approval requires an exact
 * match: the same tool names with the same digests, nothing extra and nothing missing.
 */
export function templateServerProposalProblems(server: McpTemplateServer, proposal: { endpoint: string; tools: readonly McpToolPin[] }, live: readonly McpToolPin[]): string[] {
  const problems: string[] = [];
  if (new Set(proposal.tools.map((t) => t.name)).size !== proposal.tools.length) problems.push("tool names must be unique");
  if (mcpTemplateServerFor(proposal.endpoint) !== server || proposal.endpoint !== server.endpoint) problems.push(`endpoint must be ${server.endpoint}`);
  const expected = templateServerTools(server, live);
  for (const m of expected.missing) problems.push(`the live server no longer lists ${m}`);
  const want = new Map(expected.tools.map((t) => [t.name, mcpToolDigest(t)]));
  const got = new Map(proposal.tools.map((t) => [t.name, mcpToolDigest(t)]));
  for (const [name, digest] of got) {
    if (!want.has(name)) problems.push(`tool ${name} is not part of this connector`);
    else if (want.get(name) !== digest) problems.push(`tool ${name} differs from the live server`);
  }
  for (const name of want.keys()) if (!got.has(name)) problems.push(`tool ${name} is missing from the proposal`);
  return problems;
}
