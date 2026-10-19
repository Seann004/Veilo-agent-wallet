/**
 * Proposes and approves one connector for a server Veilo ships fixed templates for, and nothing
 * else in the seed. It talks to the running marketplace (MARKETPLACE_URL) with the operator
 * credential file, which is never printed.
 *
 *   pnpm marketplace:connector coingecko-market             read-only plan
 *   pnpm marketplace:connector coingecko-market --confirm   propose (if needed), recheck digests, approve
 *
 * When the owner already proposed the connector from the dashboard, --confirm approves that
 * proposal only if it matches the live tools/list exactly. Otherwise the seed's demo creator
 * (work/marketplace-seed/keys, 0600) proposes it. An approval is recorded in the seed state so a
 * later `pnpm marketplace:seed --confirm` skips this connector.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { findRepoRoot, loadDotEnv } from "@veilo/contracts";
import { MCP_TEMPLATE_SERVERS, mcpTemplateServer, mcpToolDigest, type McpToolPin } from "@veilo/contracts/marketplace";
import { McpClient } from "@veilo/mcp-client";
import { runTemplateConnector, type ConnectorPlan } from "../../services/marketplace/src/connector-approval";
import { keyFor, web3Session } from "./web3-session";

const args = process.argv.slice(2).filter((a) => a !== "--");
const confirm = args.includes("--confirm");
const id = args.find((a) => !a.startsWith("--"));
const server = id ? mcpTemplateServer(id) : undefined;
if (!server) {
  console.error(`usage: pnpm marketplace:connector <${MCP_TEMPLATE_SERVERS.map((s) => s.id).join("|")}> [--confirm]`);
  process.exit(2);
}

const rootDir = findRepoRoot();
loadDotEnv({ rootDir });
const base = (process.env.MARKETPLACE_URL ?? "http://127.0.0.1:4106").replace(/\/$/, "");
const tokenPath = process.env.MARKETPLACE_OPERATOR_TOKEN_PATH ?? "secrets/marketplace/operator.token";
const operatorToken = readFileSync(isAbsolute(tokenPath) ? tokenPath : join(rootDir, tokenPath), "utf8").trim();
const seedDir = join(rootDir, "work", "marketplace-seed");

async function call<T>(method: string, path: string, token: string | null, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error(`the marketplace at ${base} is not reachable; start it with pnpm dev`);
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: { code?: string; message?: string }; problems?: string[] }) | null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json?.error?.code ?? ""} ${json?.error?.message ?? ""} ${(json?.problems ?? []).join("; ")}`.trim());
  return json as T;
}

const pinOf = (t: McpToolPin): McpToolPin => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, ...(t.template ? { template: t.template } : {}) });
type Row = { id: string; endpoint: string; tools: McpToolPin[] };

function describe(plan: ConnectorPlan): unknown {
  switch (plan.action) {
    case "propose-and-approve":
      return { action: "propose, recheck the live tools/list, approve", connector: { id: plan.proposal.id, title: plan.proposal.title, endpoint: plan.proposal.endpoint }, tools: plan.proposal.tools.map((t) => ({ name: t.name, sha256: mcpToolDigest(t), ...(t.template ? { runs: `fixed template through ${t.template.upstream}`, upstreamSha256: t.template.upstreamSha256 } : {}) })) };
    case "approve-pending":
      return { action: "recheck the live tools/list, approve the pending proposal", tools: plan.tools };
    case "none":
      return { action: "nothing to do", reason: plan.reason };
    case "refuse":
      return { action: "refused", problems: plan.problems };
  }
}

function recordInSeedState(tools: McpToolPin[]): void {
  const path = join(seedDir, "state.json");
  const state = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { steps: Record<string, unknown> }) : { steps: {} };
  const upstream = Object.fromEntries(tools.filter((t) => t.template).map((t) => [t.template!.upstream, t.template!.upstreamSha256]));
  state.steps[`connector.${server!.id}`] = { tools: tools.map((t) => ({ name: t.name, sha256: mcpToolDigest(t) })), ...(Object.keys(upstream).length > 0 ? { upstream } : {}) };
  mkdirSync(seedDir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
}

async function main(): Promise<void> {
  const s = server!;
  let approvedTools: McpToolPin[] = [];
  const r = await runTemplateConnector(
    s,
    {
      liveTools: async (endpoint) => {
        const client = new McpClient(endpoint, { publicOnly: true, timeoutMs: 20_000, maxBytes: 4_000_000, clientName: "veilo-operator" });
        await client.initialize();
        return client.listTools();
      },
      approved: async (cid) => {
        const c = (await call<{ connectors: Row[] }>("GET", "/marketplace/connectors", null)).connectors.find((x) => x.id === cid);
        return c ? { endpoint: c.endpoint, tools: c.tools.map(pinOf) } : null;
      },
      pending: async (cid) => {
        const c = (await call<{ connectors: Row[] }>("GET", "/operator/workflow-review-queue", operatorToken)).connectors.find((x) => x.id === cid);
        return c ? { endpoint: c.endpoint, tools: c.tools.map(pinOf) } : null;
      },
      propose: async (proposal) => {
        const proposer = await web3Session(await keyFor(join(seedDir, "keys"), "ledger-lab"));
        await call("POST", "/me/bootstrap", proposer.token, {});
        await call("POST", "/tools/connectors", proposer.token, proposal);
        approvedTools = proposal.tools;
      },
      approve: async (cid, note) => {
        await call("POST", `/operator/connectors/${cid}/review`, operatorToken, { approve: true, note });
      },
    },
    confirm,
  );
  console.log(JSON.stringify({ marketplace: base, ...(describe(r.plan) as object), outcome: r.outcome }, null, 2));
  if (r.outcome === "dry-run") console.log(`Read-only plan. Re-run with --confirm to carry it out.`);
  if (r.outcome === "approved") {
    if (r.plan.action === "approve-pending") approvedTools = (await call<{ connectors: Row[] }>("GET", "/marketplace/connectors", null)).connectors.find((x) => x.id === s.id)?.tools.map(pinOf) ?? [];
    recordInSeedState(approvedTools);
    console.log(`Approved ${s.id}. Attach "${s.title}" to an agent on the dashboard's Connectors page.`);
  }
  if (r.outcome === "refused") process.exit(1);
}

main().catch((error: unknown) => {
  console.error(`connector aborted: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
