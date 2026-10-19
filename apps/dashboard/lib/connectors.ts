import { ApiError, api } from "./api";

/** One tool exactly as the operator reviewed it; `sha256` pins name, description and schema. */
export interface ConnectorTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  sha256?: string;
  /** Set when Veilo runs a fixed query through the server's code tool; the agent never sends code. */
  template?: { upstream: string };
}

/** Operator-approved connector from GET /marketplace/connectors. */
export interface Connector {
  id: string;
  title: string;
  endpoint: string;
  transport?: string;
  manifest_sha256?: string;
  risk?: string;
  tools: ConnectorTool[];
}

export type ReviewStatus = "pending" | "approved" | "withdrawn";
const REVIEW_STATUSES: readonly string[] = ["pending", "approved", "withdrawn"];

/** A connector the signed-in user proposed, from GET /tools/connectors/mine. */
export interface ConnectorProposalRecord {
  id: string;
  title: string;
  endpoint: string;
  /** One of ReviewStatus, or another value the marketplace reports; unknown values are shown as-is. */
  reviewStatus: string;
  reviewNote: string | null;
  tools: ConnectorTool[];
}

export interface Attachment {
  connectorId: string;
  tools: string[];
  attachedAt: string;
  /** "active", or e.g. "changed" when the server's tools no longer match their review. */
  status: string;
}

/** Only an active attachment counts as connected. */
export const isActive = (a: Attachment): boolean => a.status === "active";

export function attachmentStatusText(status: string): string {
  if (status === "changed") return "Disabled: the server changed its tools";
  return status === "active" ? "Connected" : `Not active (${status})`;
}

/** Attachments of one agent; "unavailable" means the control service has no connector endpoints yet. */
export type AgentAttachments = { kind: "ok"; attached: Attachment[] } | { kind: "unavailable" };

const REVIEW_LABEL: Record<ReviewStatus, string> = { pending: "In review", approved: "Approved", withdrawn: "Withdrawn" };
const REVIEW_PILL: Record<ReviewStatus, string> = { pending: "pill pill-warn", approved: "pill pill-ok", withdrawn: "pill pill-muted" };

export function reviewChip(status: string): { label: string; className: string } {
  if (REVIEW_STATUSES.includes(status)) return { label: REVIEW_LABEL[status as ReviewStatus], className: REVIEW_PILL[status as ReviewStatus] };
  return { label: status ? status.charAt(0).toUpperCase() + status.slice(1) : "Unknown", className: "pill pill-muted" };
}

export const PINNED_TOOLS_NOTE = "Veilo calls only these exact tools; if the server changes them, they are disabled until reviewed again.";
export const KEYED_UNSUPPORTED = "Connectors that need an API key, OAuth sign-in or an account aren't supported yet.";

/** Marketplace origin from NEXT_PUBLIC_MARKETPLACE_URL; null when unset or not an http(s) URL. */
export function marketplaceOrigin(raw: string | undefined = process.env.NEXT_PUBLIC_MARKETPLACE_URL): string | null {
  const v = raw?.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

type TokenSource = () => Promise<string | null>;
let tokenSource: TokenSource | null = null;

/** Registers where the marketplace bearer token comes from. Without one, signed-in calls are refused locally. */
export function setMarketplaceTokenSource(source: TokenSource | null): void {
  tokenSource = source;
}

export const hasMarketplaceSignIn = (): boolean => tokenSource !== null;

/**
 * Calls the marketplace directly. Only a bearer token authenticates; cookies are never sent, so a
 * cross-site page cannot ride on a session.
 */
async function marketplace<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown; signedIn?: boolean; tokenSource?: TokenSource | undefined } = {}): Promise<T> {
  const origin = marketplaceOrigin();
  if (!origin) throw new ApiError(0, "NOT_READY", "the marketplace is not configured (NEXT_PUBLIC_MARKETPLACE_URL)");
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.signedIn) {
    const source = init.tokenSource ?? tokenSource;
    if (!source) throw new ApiError(0, "NOT_READY", "marketplace sign-in is not part of this dashboard yet");
    const token = await source();
    if (!token) throw new ApiError(401, "UNAUTHENTICATED", "sign in to the marketplace with your wallet first");
    headers.authorization = `Bearer ${token}`;
  }
  if (method !== "GET") headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${origin}${path}`, {
      method,
      headers,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      ...(method !== "GET" ? { body: JSON.stringify(init.body ?? {}) } : {}),
    });
  } catch {
    throw new ApiError(0, "NOT_READY", "the marketplace service is not reachable");
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const e = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? (res.status === 404 || res.status >= 502 ? "NOT_READY" : "INTERNAL_ERROR"), e?.message ?? `marketplace request failed with status ${res.status}`);
  }
  return body as T;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function toolsOf(v: unknown): ConnectorTool[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isRecord).map((t) => ({
    name: str(t.name),
    description: str(t.description),
    inputSchema: isRecord(t.inputSchema) ? t.inputSchema : {},
    ...(typeof t.sha256 === "string" ? { sha256: t.sha256 } : {}),
    ...(isRecord(t.template) && typeof t.template.upstream === "string" ? { template: { upstream: t.template.upstream } } : {}),
  }));
}

/** Approved connectors only. Fields are coerced to strings so nothing but text reaches the page. */
export async function listConnectors(): Promise<Connector[]> {
  const r = await marketplace<{ connectors?: unknown }>("/marketplace/connectors");
  const list = Array.isArray(r?.connectors) ? r.connectors : [];
  return list.filter(isRecord).map((c) => ({
    id: str(c.id),
    title: c.id === "coingecko-docs" ? "CoinGecko docs search only" : str(c.title),
    endpoint: str(c.endpoint),
    transport: str(c.transport),
    manifest_sha256: str(c.manifest_sha256),
    risk: str(c.risk),
    tools: toolsOf(c.tools),
  }));
}

export async function myProposals(): Promise<ConnectorProposalRecord[]> {
  const r = await marketplace<{ connectors?: unknown }>("/tools/connectors/mine", { signedIn: true });
  const list = Array.isArray(r?.connectors) ? r.connectors : [];
  return list.filter(isRecord).map((c) => ({
    id: str(c.id),
    title: c.id === "coingecko-docs" ? "CoinGecko docs search only" : str(c.title),
    endpoint: str(c.endpoint),
    reviewStatus: str(c.reviewStatus),
    reviewNote: typeof c.reviewNote === "string" && c.reviewNote !== "" ? c.reviewNote : null,
    tools: toolsOf(c.tools),
  }));
}

export interface ConnectorProposal {
  id: string;
  title: string;
  endpoint: string;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; template?: { upstream: string; codeSha256: string; upstreamSha256: string } }>;
}

export function proposeConnector(p: ConnectorProposal, source?: TokenSource): Promise<{ connectorId: string; status: string }> {
  return marketplace("/tools/connectors", { method: "POST", body: p, signedIn: true, tokenSource: source });
}

/**
 * The control service (or the proxy) doesn't serve this route at all. Other 404s, such as an
 * unknown agent or a connector that isn't attached, are real errors.
 */
export const isNotAvailable = (e: unknown): boolean => e instanceof ApiError && e.status === 404 && (e.code === "NOT_READY" || e.message === "no such endpoint");

export async function agentAttachments(agentId: string): Promise<AgentAttachments> {
  try {
    const r = await api<{ attached?: unknown }>("control", `/agents/${encodeURIComponent(agentId)}/connectors`);
    const list = Array.isArray(r?.attached) ? r.attached : [];
    return {
      kind: "ok",
      attached: list.filter(isRecord).map((a) => ({ connectorId: str(a.connectorId), tools: Array.isArray(a.tools) ? a.tools.filter((t): t is string => typeof t === "string") : [], attachedAt: str(a.attachedAt), status: typeof a.status === "string" ? a.status : "active" })),
    };
  } catch (e) {
    if (isNotAvailable(e)) return { kind: "unavailable" };
    throw e;
  }
}

export function attachConnector(agentId: string, connectorId: string, tools: string[]): Promise<unknown> {
  return api("control", `/agents/${encodeURIComponent(agentId)}/connectors/${encodeURIComponent(connectorId)}`, { method: "PUT", body: { tools } });
}

export function detachConnector(agentId: string, connectorId: string): Promise<unknown> {
  return api("control", `/agents/${encodeURIComponent(agentId)}/connectors/${encodeURIComponent(connectorId)}`, { method: "DELETE" });
}

/** Attachments for several agents at once. Any agent reporting "unavailable" makes the whole map unavailable. */
export async function workspaceAttachments(agentIds: string[]): Promise<Map<string, Attachment[]> | "unavailable"> {
  const results = await Promise.all(agentIds.map((id) => agentAttachments(id)));
  if (results.some((r) => r.kind === "unavailable")) return "unavailable";
  return new Map(agentIds.map((id, i) => [id, (results[i] as { attached: Attachment[] }).attached]));
}

// ---------- Presentation helpers ----------

export function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/** One line built from the tool descriptions, cut at a word boundary. */
export function summaryOf(c: Pick<Connector, "tools">, max = 120): string {
  const first = c.tools.map((t) => t.description.replace(/\s+/g, " ").trim()).find((d) => d !== "") ?? "";
  if (first.length <= max) return first;
  const cut = first.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 20)).trimEnd()}…`;
}

export function monogram(title: string, id: string): string {
  const words = (title || id).replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? "")).toUpperCase();
}

export function shortDigest(d: string | undefined): string {
  if (!d) return "—";
  return d.length > 20 ? `${d.slice(0, 10)}…${d.slice(-6)}` : d;
}

export function matchesQuery(c: { id: string; title: string; tools: ConnectorTool[] }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [c.id, c.title, ...c.tools.flatMap((t) => [t.name, t.description])].some((s) => s.toLowerCase().includes(q));
}

// ---------- Proposal validation (mirrors the marketplace's own checks) ----------

export const CONNECTOR_ID_RE = /^[a-z0-9][a-z0-9-]{2,62}$/;
const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Only public https servers; null when acceptable. */
export function endpointProblem(value: string): string | null {
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    return "Enter a full URL starting with https://.";
  }
  if (u.protocol !== "https:") return "The endpoint must use https.";
  if (u.username || u.password || u.search || u.hash) return "Remove credentials, query strings and fragments from the URL.";
  const host = u.hostname.toLowerCase();
  if (host.endsWith(".") || host === "localhost" || /\.(local|internal|localhost)$/.test(host) || /^[0-9.]+$/.test(host) || host.startsWith("[") || !host.includes(".")) {
    return "The endpoint must be a public domain name, not localhost or an IP address.";
  }
  if (value.length > 300) return "The endpoint is too long.";
  return null;
}

/** Parses an input schema; it must be a JSON object describing an object. */
export function parseInputSchema(text: string): { schema: Record<string, unknown> } | { problem: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { problem: "Not valid JSON." };
  }
  if (!isRecord(v)) return { problem: "The schema must be a JSON object." };
  if (v.type !== "object") return { problem: 'The schema must have "type": "object".' };
  if (v.properties !== undefined && !isRecord(v.properties)) return { problem: '"properties" must be an object.' };
  if (v.required !== undefined && !(Array.isArray(v.required) && v.required.every((r) => typeof r === "string"))) return { problem: '"required" must be a list of names.' };
  return { schema: v };
}

export interface ToolDraft {
  name: string;
  description: string;
  schema: string;
}

export interface ProposalDraft {
  id: string;
  title: string;
  endpoint: string;
  tools: ToolDraft[];
}

export interface ProposalProblems {
  id?: string;
  title?: string;
  endpoint?: string;
  tools?: string;
  tool: Array<{ name?: string; description?: string; schema?: string }>;
}

export function validateProposal(d: ProposalDraft): { proposal: ConnectorProposal | null; problems: ProposalProblems } {
  const problems: ProposalProblems = { tool: d.tools.map(() => ({})) };
  if (!CONNECTOR_ID_RE.test(d.id)) problems.id = "Use 3–63 lowercase letters, digits or dashes, starting with a letter or digit.";
  const title = d.title.trim();
  if (title.length < 3 || title.length > 80) problems.title = "Use 3–80 characters.";
  const ep = endpointProblem(d.endpoint);
  if (ep) problems.endpoint = ep;
  if (d.tools.length === 0) problems.tools = "Add at least one tool.";
  if (d.tools.length > 32) problems.tools = "Use at most 32 tools.";
  const seen = new Set<string>();
  const tools: ConnectorProposal["tools"] = [];
  d.tools.forEach((t, i) => {
    const p = problems.tool[i]!;
    if (!TOOL_NAME_RE.test(t.name)) p.name = "Use up to 64 letters, digits, dots, dashes or underscores.";
    else if (seen.has(t.name)) p.name = "Tool names must be unique.";
    seen.add(t.name);
    if (t.description.length > 8000) p.description = "Use at most 8,000 characters.";
    const s = parseInputSchema(t.schema);
    if ("problem" in s) p.schema = s.problem;
    else tools.push({ name: t.name, description: t.description, inputSchema: s.schema });
  });
  const ok = !problems.id && !problems.title && !problems.endpoint && !problems.tools && problems.tool.every((p) => !p.name && !p.description && !p.schema);
  return { proposal: ok ? { id: d.id, title, endpoint: d.endpoint.trim(), tools } : null, problems };
}

/** Accepts a tools/list result, its JSON-RPC envelope or a bare array of tools. */
export function parseToolsList(text: string): { tools: ToolDraft[] } | { problem: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { problem: "Not valid JSON." };
  }
  const list = Array.isArray(v) ? v : isRecord(v) && Array.isArray(v.tools) ? v.tools : isRecord(v) && isRecord(v.result) && Array.isArray(v.result.tools) ? v.result.tools : null;
  if (!list) return { problem: 'Expected {"tools": [...]} from tools/list.' };
  if (list.length === 0) return { problem: "The list has no tools." };
  const tools: ToolDraft[] = [];
  for (const t of list) {
    if (!isRecord(t) || typeof t.name !== "string") return { problem: "Every tool needs a name." };
    tools.push({ name: t.name, description: str(t.description), schema: JSON.stringify(isRecord(t.inputSchema) ? t.inputSchema : { type: "object", properties: {} }, null, 2) });
  }
  return { tools };
}

export type AttachState = "connected" | "unconfirmed" | "failed" | "unavailable";
export interface AttachOutcome {
  connectorId: string;
  state: AttachState;
  message?: string;
}

/**
 * Attaches several connectors and reports each one separately. "connected" only when a fresh
 * GET lists it; a successful PUT that the GET doesn't confirm stays "unconfirmed". Never throws.
 */
export async function attachMany(agentId: string, items: Array<{ connectorId: string; tools: string[] }>): Promise<AttachOutcome[]> {
  const settled = await Promise.allSettled(items.map((i) => attachConnector(agentId, i.connectorId, i.tools)));
  let confirmed: Set<string> | null = null;
  if (settled.some((s) => s.status === "fulfilled")) {
    try {
      const r = await agentAttachments(agentId);
      if (r.kind === "ok") confirmed = new Set(r.attached.filter(isActive).map((a) => a.connectorId));
    } catch {
      confirmed = null;
    }
  }
  return items.map((item, k) => {
    const s = settled[k]!;
    if (s.status === "rejected") {
      return { connectorId: item.connectorId, state: isNotAvailable(s.reason) ? "unavailable" : "failed", message: s.reason instanceof Error ? s.reason.message : "unexpected error" };
    }
    return { connectorId: item.connectorId, state: confirmed?.has(item.connectorId) ? "connected" : "unconfirmed" };
  });
}


export interface TemplateConnectorPreview {
  connectorId: string;
  title: string;
  endpoint: string;
  explanation: string;
  tools: ConnectorProposal["tools"];
}

export function previewTemplateConnector(endpoint: string, source?: TokenSource): Promise<TemplateConnectorPreview> {
  return marketplace("/tools/connectors/template-preview", { method: "POST", body: { endpoint }, signedIn: true, tokenSource: source });
}
