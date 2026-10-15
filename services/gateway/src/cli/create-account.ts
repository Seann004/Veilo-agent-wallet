// Creates the workspace's single gateway account and writes its bearer token to a new file
// (owner-only permissions). The token is never printed.
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { findRepoRoot, loadConfig, loadDotEnv } from "@veilo/contracts";
import { createAccount } from "../auth";
import { openGatewayDb } from "../db/database";

const { values } = parseArgs({
  options: {
    workspace: { type: "string" },
    subject: { type: "string", default: "control-service" },
    out: { type: "string" },
  },
});

if (!values.workspace || !values.out) {
  console.error("usage: create-account --workspace <workspace-id> --out <token-file> [--subject <name>]");
  process.exit(2);
}
const rootDir = findRepoRoot();
loadDotEnv({ rootDir });
const config = loadConfig(process.env, { rootDir });
const out = resolve(rootDir, values.out);
if (existsSync(out)) {
  console.error(`refusing to overwrite existing credential file ${out}`);
  process.exit(1);
}
const db = openGatewayDb(config.paths.gatewayDatabase);
const created = createAccount(db, values.workspace, values.subject ?? "control-service");
writeFileSync(out, `${created.token}\n`, { mode: 0o600, flag: "wx" });
db.close();
console.log(JSON.stringify({ accountId: created.accountId, workspaceId: values.workspace, tokenFile: out }));
