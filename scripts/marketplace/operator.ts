/**
 * Operator review CLI for the marketplace (reads the operator credential file; never prints it).
 *
 *   pnpm marketplace:operator queue
 *   pnpm marketplace:operator approve-seller <sellerId>
 *   pnpm marketplace:operator suspend-seller <sellerId>
 *   pnpm marketplace:operator review <versionId> approve|reject [note]
 *   pnpm marketplace:operator host-credential <sellerId>     (prints a new remote seller-host token once)
 *   pnpm marketplace:operator sweep
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { findRepoRoot, loadDotEnv } from "@veilo/contracts";

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
};
const action = cmd ? actions[cmd] : undefined;
if (!action) {
  console.error("usage: pnpm marketplace:operator queue|approve-seller|suspend-seller|review|host-credential|sweep …");
  process.exit(2);
}
action().then(
  (r) => console.log(JSON.stringify(r, null, 2)),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
