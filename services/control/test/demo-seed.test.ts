import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_TOKEN_MINT, DEVNET_GENESIS_HASH } from "@veilo/contracts";
import { immediate, openControlDatabase, openSqlite } from "@veilo/db";
import { createLedger } from "../src/context";
import { revokeAgent } from "../src/ledger/authority";
import { insertAgent } from "../src/ledger/workspace";
import { testKeypair } from "./helpers";

const repoRoot = resolve(import.meta.dirname, "../../..");
const tsxCli = createRequire(join(repoRoot, "package.json")).resolve("tsx/cli");
let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function seed(d: string, owner: string, extra: Record<string, string> = {}) {
  const envFile = join(d, "empty.env");
  writeFileSync(envFile, "");
  return spawnSync(process.execPath, [tsxCli, "scripts/demo-seed.ts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      VEILO_ENV_FILE: envFile,
      DEVNET_RPC_URL: "https://rpc.test.invalid",
      EXPECTED_DEVNET_GENESIS_HASH: DEVNET_GENESIS_HASH,
      DEMO_TOKEN_MINT,
      FACILITATOR_URL: "https://facilitator.payai.network",
      VEILO_OWNER_PUBKEY: owner,
      VEILO_DATA_DIR: join(d, "data"),
      VEILO_SECRETS_DIR: join(d, "secrets"),
      CONTROL_DATABASE_PATH: join(d, "data", "control.sqlite"),
      GATEWAY_DATABASE_PATH: join(d, "data", "gateway.sqlite"),
      DEPLOYMENT_MANIFEST_PATH: join(d, "none.json"),
      ...extra,
    },
  });
}

describe("pnpm demo:seed", () => {
  it("is idempotent, creates one shared account and never adds credits or prints secrets", () => {
    dir = mkdtempSync(join(tmpdir(), "veilo-seed-"));
    const owner = testKeypair().address;
    const first = seed(dir, owner);
    expect(first.status, first.stderr).toBe(0);
    const tokenPath = join(dir, "secrets", "control", "gateway-account.token");
    const permitKey = join(dir, "secrets", "control", "usage-permit-signing.pem");
    const creds = join(dir, "secrets", "runner", "worker-credentials.json");
    for (const p of [tokenPath, permitKey, join(dir, "secrets", "gateway", "usage-permit-public.pem"), join(dir, "secrets", "gateway", "planning.token"), creds]) {
      expect(existsSync(p)).toBe(true);
    }
    const secrets = [readFileSync(tokenPath, "utf8").trim(), readFileSync(join(dir, "secrets", "gateway", "planning.token"), "utf8").trim(), ...((JSON.parse(readFileSync(creds, "utf8")) as { agents: Array<{ token: string }> }).agents.map((a) => a.token))];
    const fingerprint = (p: string) => readFileSync(p, "utf8");
    const before = [tokenPath, permitKey, creds].map(fingerprint);

    const second = seed(dir, owner);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("already present (unchanged)");
    expect([tokenPath, permitKey, creds].map(fingerprint)).toEqual(before);
    for (const out of [first.stdout, first.stderr, second.stdout, second.stderr]) {
      for (const secret of secrets) expect(out).not.toContain(secret);
      expect(out).not.toContain("PRIVATE KEY");
    }

    const g = openSqlite(join(dir, "data", "gateway.sqlite"));
    expect(g.prepare("SELECT count(*) AS n, sum(issued) AS issued FROM accounts").get()).toEqual({ n: 1, issued: 0 });
    expect(g.prepare("SELECT count(*) AS n FROM credit_events").get()).toEqual({ n: 0 });
    g.close();
    const c = openControlDatabase(join(dir, "data", "control.sqlite"));
    expect(Number(c.prepare("SELECT count(*) FROM agent").pluck().get())).toBe(3);
    expect(Number(c.prepare("SELECT count(*) FROM workspace").pluck().get())).toBe(1);
    expect(Number(c.prepare("SELECT count(*) FROM policy WHERE status = 'active'").pluck().get())).toBe(0);
    expect(Number(c.prepare("SELECT count(DISTINCT target_account_id) FROM agent").pluck().get())).toBe(1);
    expect(Number(c.prepare("SELECT count(*) FROM approved_service WHERE status = 'unbound'").pluck().get())).toBe(2);
    expect(Number(c.prepare("SELECT count(*) FROM service_sku").pluck().get())).toBe(9);
    c.close();

    // Agents created later get a credential on the next run; existing entries stay as they were.
    const db = openControlDatabase(join(dir, "data", "control.sqlite"));
    const ledger = createLedger(db);
    const wsId = String(db.prepare("SELECT id FROM workspace").pluck().get());
    const policy = { tier: "bounded_automatic" as const, lifetimeTestUsdc: "1", rolling24hTestUsdc: "1", maxPurchaseTestUsdc: "1", taskLimitTestUsdc: "1", usageAllowanceUnits: "0", taskCreditUnits: "0", allowedSkus: [], allowedPaymentPaths: [] };
    const scout = immediate(db, () => insertAgent(ledger, wsId, { name: "Scout", role: "custom", instructions: "Find a specialist.", policy }, "owner"));
    const gone = immediate(db, () => insertAgent(ledger, wsId, { name: "Gone", role: "custom", instructions: "Unused.", policy }, "owner"));
    revokeAgent(ledger, wsId, gone.id, "owner");
    const credit = immediate(db, () => insertAgent(ledger, wsId, { name: "Second credit", role: "credit_manager", policy }, "owner"));
    db.close();
    const prior = (JSON.parse(before[2]!) as { agents: Array<Record<string, string>> }).agents;
    const added = seed(dir, owner);
    expect(added.status, added.stderr).toBe(0);
    expect(added.stdout).toContain("added worker credentials for Scout");
    const after = JSON.parse(readFileSync(creds, "utf8")) as { agents: Array<Record<string, string>> };
    expect(after.agents.slice(0, prior.length)).toEqual(prior);
    expect(after.agents.slice(prior.length).map((a) => [a.agentId, a.role])).toEqual([[scout.id, "custom"]]);
    expect(after.agents.some((a) => a.agentId === gone.id || a.agentId === credit.id)).toBe(false);
    if (process.platform !== "win32") expect(statSync(creds).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, "secrets", "runner")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const newToken = after.agents.at(-1)!.token!;
    expect(newToken).toMatch(/^vwk_/);
    expect(added.stdout + added.stderr).not.toContain(newToken);
    const afterAdd = fingerprint(creds);
    const again = seed(dir, owner);
    expect(again.status, again.stderr).toBe(0);
    expect(fingerprint(creds)).toBe(afterAdd);

    // Losing the control token never creates a second account.
    rmSync(tokenPath);
    const third = seed(dir, owner);
    expect(third.status).toBe(1);
    expect(third.stderr).toMatch(/second account is never created/);
  }, 60_000);
});
