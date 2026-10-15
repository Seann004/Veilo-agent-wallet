import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_TOKEN_MINT, DEVNET_GENESIS_HASH } from "@veilo/contracts";
import { openControlDatabase, openSqlite } from "@veilo/db";
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

    // Losing the control token never creates a second account.
    rmSync(tokenPath);
    const third = seed(dir, owner);
    expect(third.status).toBe(1);
    expect(third.stderr).toMatch(/second account is never created/);
  }, 60_000);
});
