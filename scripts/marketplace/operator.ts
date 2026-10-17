/**
 * Operator review CLI for the marketplace (reads the operator credential file; never prints it).
 *
 *   pnpm marketplace:operator queue
 *   pnpm marketplace:operator approve-seller <sellerId>
 *   pnpm marketplace:operator suspend-seller <sellerId>
 *   pnpm marketplace:operator review <versionId> approve|reject [note]
 *   pnpm marketplace:operator host-credential <sellerId>     (prints a new remote seller-host token once)
 *   pnpm marketplace:operator sweep
 *   pnpm marketplace:operator workflow-queue
 *   pnpm marketplace:operator workflow-review <versionId> approve|reject [note]
 *   pnpm marketplace:operator workflow-status <workflowId> suspended|live
 *   pnpm marketplace:operator external-tool <toolId> approved|suspended [note]
 *   pnpm marketplace:operator connector-verify <connectorId>  (reads the live tools/list and compares digests)
 *   pnpm marketplace:operator connector-review <connectorId> approve|reject [note]
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { findRepoRoot, loadDotEnv } from "@veilo/contracts";
import { mcpToolDigest, type McpToolPin } from "@veilo/contracts/marketplace";
import { McpClient } from "../../services/gateway/src/seller-host/mcp";

const rootDir = findRepoRoot();
loadDotEnv({ rootDir });
const base = (process.env.MARKETPLACE_URL ?? "http://127.0.0.1:4106").replace(/\/$/, "");
const tokenPath = process.env.MARKETPLACE_OPERATOR_TOKEN_PATH ?? "secrets/marketplace/operator.token";
const token = readFileSync(isAbsolute(tokenPath) ? tokenPath : join(rootDir, tokenPath), "utf8").trim();

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const [cmd, a, b, ...rest] = process.argv.slice(2);
const actions: Record<string, () => Promise<unknown>> = {
  queue: () => call("GET", "/operator/review-queue"),
  "approve-seller": () => call("POST", `/operator/sellers/${a}/status`, { status: "approved" }),
  "suspend-seller": () => call("POST", `/operator/sellers/${a}/status`, { status: "suspended" }),
  review: () => call("POST", `/operator/versions/${a}/review`, { approve: b === "approve", note: rest.join(" ") || null }),
  "host-credential": () => call("POST", `/operator/sellers/${a}/host-credential`),
  sweep: () => call("POST", "/operator/sweep"),
  "workflow-queue": () => call("GET", "/operator/workflow-review-queue"),
  "workflow-review": () => call("POST", `/operator/workflow-versions/${a}/review`, { approve: b === "approve", note: rest.join(" ") || null }),
  "workflow-status": () => call("POST", `/operator/workflows/${a}/status`, { status: b }),
  "external-tool": () => call("POST", `/operator/external-tools/${a}/status`, { status: b, note: rest.join(" ") || null }),
  "connector-review": () => call("POST", `/operator/connectors/${a}/review`, { approve: b === "approve", note: rest.join(" ") || null }),
  "connector-verify": async () => {
    const q = (await call("GET", "/operator/workflow-review-queue")) as { connectors: Array<{ id: string; endpoint: string; tools: McpToolPin[] }> };
    const c = q.connectors.find((x) => x.id === a);
    if (!c) throw new Error(`no pending connector ${a}`);
    const client = new McpClient(c.endpoint);
    await client.initialize();
    const live = new Map((await client.listTools()).map((t) => [t.name, mcpToolDigest(t)]));
    return { endpoint: c.endpoint, tools: c.tools.map((t) => ({ name: t.name, proposed: mcpToolDigest(t), live: live.get(t.name) ?? null, matches: live.get(t.name) === mcpToolDigest(t) })) };
  },
};
const action = cmd ? actions[cmd] : undefined;
if (!action) {
  console.error("usage: pnpm marketplace:operator queue|approve-seller|suspend-seller|review|host-credential|sweep|workflow-queue|workflow-review|workflow-status|external-tool|connector-verify|connector-review …");
  process.exit(2);
}
action().then(
  (r) => console.log(JSON.stringify(r, null, 2)),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
