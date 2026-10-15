// Idempotent demo seed: one workspace with the three role agents and draft demo policies, the
// fixed SKU catalog, one shared gateway credit account, local integration secrets and runner
// worker credentials. It never issues credits, moves funds, activates policies or prints secrets.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { isAddress } from "@solana/kit";
import { VeiloConfigError, findRepoRoot, loadConfig, loadDotEnv } from "@veilo/contracts";
import { FIXTURE_DATA_LABEL, generateUsagePermitKeyPair, loadGatewayConfig } from "@veilo/contracts/gateway";
import { deriveAta } from "@veilo/x402-client";
import { openControlDatabase } from "../packages/db/src/index";
import { issueWorkerCredential } from "../services/control/src/auth/credentials";
import { createLedger } from "../services/control/src/context";
import { integrationPaths } from "../services/control/src/integration/paths";
import { listAgents, seedWorkspace } from "../services/control/src/ledger/workspace";
import { createAccount, hashToken } from "../services/gateway/src/auth";
import { openGatewayDb } from "../services/gateway/src/db/database";

const rootDir = findRepoRoot();
const rel = (p: string) => relative(rootDir, p).split("\\").join("/");
const log = (m: string) => console.log(`  ${m}`);

function restrict(path: string, isDir: boolean): void {
  if (process.platform !== "win32") {
    chmodSync(path, isDir ? 0o700 : 0o600);
    return;
  }
  const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
  if (!user) return;
  spawnSync("icacls", [path, "/inheritance:r", "/grant:r", isDir ? `${user}:(OI)(CI)F` : `${user}:F`], { encoding: "utf8" });
}

/** Writes a new secret file with owner-only permissions; never overwrites an existing one. */
function writeSecret(path: string, contents: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    restrict(dir, true);
  }
  writeFileSync(path, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  restrict(path, false);
}

async function main(): Promise<void> {
  loadDotEnv({ rootDir });
  const config = loadConfig(process.env, { rootDir });
  const gw = loadGatewayConfig(config, process.env, { rootDir });
  const owner = process.env.VEILO_OWNER_PUBKEY?.trim();
  if (!owner || !isAddress(owner)) throw new VeiloConfigError("INVALID_CONFIG", "VEILO_OWNER_PUBKEY must be set to the owner's base58 wallet address");
  const paths = integrationPaths(config, process.env, rootDir);

  console.log("Integration secrets (contents never printed)");
  const havePriv = existsSync(paths.permitPrivateKey);
  const havePub = existsSync(paths.permitPublicKey);
  if (havePriv !== havePub) {
    throw new VeiloConfigError("INVALID_CONFIG", "only one half of the usage-permit key pair exists; restore the missing file instead of regenerating");
  }
  if (!havePriv) {
    const pair = generateUsagePermitKeyPair();
    writeSecret(paths.permitPrivateKey, pair.privateKeyPem);
    writeSecret(paths.permitPublicKey, pair.publicKeyPem);
    log(`created usage-permit key pair: private ${rel(paths.permitPrivateKey)} (control), public ${rel(paths.permitPublicKey)} (gateway)`);
  } else log("usage-permit key pair present (kept)");
  if (!existsSync(paths.planningToken)) {
    writeSecret(paths.planningToken, `vpl_${randomBytes(32).toString("base64url")}\n`);
    log(`created sponsored-planning credential ${rel(paths.planningToken)}`);
  } else log("sponsored-planning credential present (kept)");

  for (const dbPath of [config.paths.controlDatabase, config.paths.gatewayDatabase]) {
    if (!existsSync(dirname(dbPath))) {
      mkdirSync(dirname(dbPath), { recursive: true });
      restrict(dirname(dbPath), true);
    }
  }

  console.log("Control workspace");
  const db = openControlDatabase(config.paths.controlDatabase, { secretsDir: config.paths.secretsDir });
  const ledger = createLedger(db);
  const { workspace, created } = seedWorkspace(ledger, { ownerPubkey: owner, network: config.network.caip2, mint: config.network.mint, mintDecimals: config.network.mintDecimals });
  log(`workspace ${workspace.id} ${created ? "created" : "already present (unchanged)"}`);

  console.log("Gateway credit account");
  const gdb = openGatewayDb(config.paths.gatewayDatabase);
  const existing = gdb.prepare("SELECT id, token_hash FROM accounts WHERE workspace_id = ?").get(workspace.id) as { id: string; token_hash: string } | undefined;
  let accountId: string;
  if (!existing) {
    const acct = createAccount(gdb, workspace.id, "control-service");
    writeSecret(paths.gatewayAccountToken, `${acct.token}\n`);
    accountId = acct.accountId;
    log(`created shared account ${accountId}; token written to ${rel(paths.gatewayAccountToken)} (control only). No credits issued`);
  } else {
    accountId = existing.id;
    const token = existsSync(paths.gatewayAccountToken) ? readFileSync(paths.gatewayAccountToken, "utf8").trim() : undefined;
    if (!token || hashToken(token) !== existing.token_hash) {
      throw new VeiloConfigError("INVALID_CONFIG", "gateway account exists but its control token file is missing or does not match; restore it (a second account is never created)");
    }
    log(`shared account ${accountId} present (unchanged; balances untouched)`);
  }
  gdb.close();
  db.prepare("UPDATE agent SET target_account_id = ? WHERE workspace_id = ? AND target_account_id IS NULL").run(accountId, workspace.id);

  console.log("Approved services");
  if (gw.merchantAddress && gw.facilitatorFeePayer) {
    const ata = await deriveAta(gw.merchantAddress, config.network.mint);
    const r = db
      .prepare(
        `UPDATE approved_service SET status = 'approved', gateway_identity = ?, recipient = ?, recipient_ata = ?, updated_at_ms = ?
         WHERE workspace_id = ? AND status = 'unbound'`,
      )
      .run(gw.identity, gw.merchantAddress, ata, Date.now(), workspace.id);
    log(`${r.changes} unbound service(s) bound to gateway ${gw.identity}, merchant ${gw.merchantAddress}`);
  } else {
    log("gateway merchant/fee payer not configured: services stay unbound and cannot be purchased (fails closed)");
  }
  const fixture = JSON.parse(readFileSync(join(rootDir, "services/gateway/fixtures/research/records.json"), "utf8")) as { label: string; license: string; records: unknown[] };
  if (fixture.label !== FIXTURE_DATA_LABEL || fixture.license !== "CC0-1.0") throw new VeiloConfigError("INVALID_CONFIG", "research fixture label or license changed");
  log(`licensed research fixture: ${fixture.records.length} records, ${fixture.license}, labeled "${fixture.label}"`);

  console.log("Runner worker credentials");
  if (!existsSync(paths.runnerCredentials)) {
    const agents = listAgents(ledger, workspace.id).filter((a) => a.role === "research" || a.role === "content");
    const entries = agents.map((a) => ({ agentId: a.id, name: a.name, role: a.role, token: issueWorkerCredential(ledger, workspace.id, a.id, "demo-seed").token }));
    writeSecret(paths.runnerCredentials, `${JSON.stringify({ agents: entries }, null, 2)}\n`);
    log(`issued worker credentials for ${entries.map((e) => e.name).join(", ")} into ${rel(paths.runnerCredentials)}`);
  } else log("runner credential file present (kept)");

  console.log("Agents (policies are seeded as drafts; the owner reviews and activates them)");
  for (const a of listAgents(ledger, workspace.id)) log(`${a.name} (${a.role}): ${a.status}`);
  db.close();

  console.log("\nSet these paths in .env if they differ (values are file paths, not secrets):");
  console.log(`  USAGE_PERMIT_PUBLIC_KEY_PATH=${rel(paths.permitPublicKey)}`);
  console.log(`  GATEWAY_PLANNING_CREDENTIAL_PATH=${rel(paths.planningToken)}`);
  console.log(`  RUNNER_WORKER_CREDENTIAL_PATH=${rel(paths.runnerCredentials)}`);
  console.log("demo:seed complete. Re-running changes nothing and never adds credits.");
}

main().catch((error: unknown) => {
  if (error instanceof VeiloConfigError) console.error(`demo:seed rejected (${error.code}): ${error.message}`);
  else console.error(`demo:seed failed: ${(error as Error).name}: ${(error as Error).message}`);
  process.exit(1);
});
