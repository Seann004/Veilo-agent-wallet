import { readFileSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_TOKEN_MINT, DEVNET_CAIP2, DEVNET_GENESIS_HASH, createServiceHealth, loadConfig } from "@veilo/contracts";
import { createApp } from "../src/app";
import { ServiceCredentials, authenticateWorker, issueWorkerCredential } from "../src/auth/credentials";
import { RunnerCredentialProvisioner } from "../src/auth/runner-credentials";
import { revokeAgent } from "../src/ledger/authority";
import { activateDefaults, createEnv, type TestEnv } from "./helpers";

const config = loadConfig({
  DEVNET_RPC_URL: "https://rpc.test.invalid",
  EXPECTED_DEVNET_GENESIS_HASH: DEVNET_GENESIS_HASH,
  DEMO_TOKEN_MINT,
  FACILITATOR_URL: "https://facilitator.payai.network",
});
const ORIGIN = "http://localhost:3000";

let env: TestEnv | undefined;
let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  env?.cleanup();
  server = undefined;
  env = undefined;
});

interface CredFile {
  agents: Array<{ agentId: string; role: string; token: string; name?: string }>;
  [k: string]: unknown;
}
const read = (path: string): CredFile => JSON.parse(readFileSync(path, "utf8")) as CredFile;

describe("runner credential provisioning", () => {
  it("issues one live credential per active runner agent into a 0600 file, idempotently", () => {
    env = createEnv();
    activateDefaults(env);
    const path = join(env.dir, "runner", "worker-credentials.json");
    const logs: string[] = [];
    const p = new RunnerCredentialProvisioner({ ledger: env.ledger, path, log: (l) => logs.push(l) });

    const first = p.sync();
    expect(first.added.sort()).toEqual([env.agents.Prince.id, env.agents.Mira.id].sort());
    const file = read(path);
    expect(file.agents.map((a) => a.agentId)).not.toContain(env.agents.Shawn.id);
    for (const a of file.agents) expect(authenticateWorker(env.ledger, a.token)?.agentId).toBe(a.agentId);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    for (const l of logs) for (const a of file.agents) expect(l).not.toContain(a.token);

    expect(p.sync()).toEqual({ added: [], removed: [] });
    expect(read(path)).toEqual(file);
  });

  it("keeps existing entries and unknown fields, and replaces only a dead token", () => {
    env = createEnv();
    activateDefaults(env);
    const path = join(env.dir, "worker-credentials.json");
    const princeToken = issueWorkerCredential(env.ledger, env.ws.id, env.agents.Prince.id, "owner").token;
    const foreign = { agentId: "00000000-0000-4000-8000-000000000000", role: "custom", token: "vwk_foreign" };
    writeFileSync(path, JSON.stringify({ note: "kept", agents: [{ agentId: env.agents.Prince.id, name: "Prince", role: "research", token: princeToken }, foreign, { agentId: env.agents.Mira.id, role: "content", token: "vwk_dead" }] }), { mode: 0o600 });

    const r = new RunnerCredentialProvisioner({ ledger: env.ledger, path }).sync();
    expect(r).toEqual({ added: [env.agents.Mira.id], removed: [] });
    const file = read(path);
    expect(file.note).toBe("kept");
    expect(file.agents[0]).toEqual({ agentId: env.agents.Prince.id, name: "Prince", role: "research", token: princeToken });
    expect(file.agents[1]).toEqual(foreign);
    const mira = file.agents.find((a) => a.agentId === env!.agents.Mira.id)!;
    expect(mira.token).not.toBe("vwk_dead");
    expect(authenticateWorker(env.ledger, mira.token)?.agentId).toBe(env.agents.Mira.id);
  });

  it("leaves a file without an agents list untouched", () => {
    env = createEnv();
    activateDefaults(env);
    const path = join(env.dir, "worker-credentials.json");
    writeFileSync(path, "{\"other\":true}");
    expect(() => new RunnerCredentialProvisioner({ ledger: env!.ledger, path }).sync()).toThrow(/no agents list/);
    expect(readFileSync(path, "utf8")).toBe("{\"other\":true}");
    expect(env.db.prepare("SELECT count(*) AS n FROM worker_credential").get()).toEqual({ n: 0n });
  });

  it("drops a revoked agent's entry", () => {
    env = createEnv();
    activateDefaults(env);
    const path = join(env.dir, "worker-credentials.json");
    const p = new RunnerCredentialProvisioner({ ledger: env.ledger, path });
    p.sync();
    revokeAgent(env.ledger, env.ws.id, env.agents.Mira.id, "owner");
    expect(p.sync()).toEqual({ added: [], removed: [env.agents.Mira.id] });
    expect(read(path).agents.map((a) => a.agentId)).toEqual([env.agents.Prince.id]);
  });
});

describe("runner credential provisioning hooks", () => {
  async function start(withProvisioner: boolean) {
    env = createEnv();
    activateDefaults(env);
    const path = join(env.dir, "runner", "worker-credentials.json");
    const app = createApp(createServiceHealth("control", config, false), {
      ledger: env.ledger,
      session: { domain: "localhost:3000", origin: ORIGIN, chainId: DEVNET_CAIP2, challengeTtlMs: 300_000, sessionTtlMs: 3_600_000, secureCookies: false },
      services: new ServiceCredentials([]),
      log: () => undefined,
      ...(withProvisioner ? { runnerCredentials: new RunnerCredentialProvisioner({ ledger: env.ledger, path }) } : {}),
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server!.once("listening", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = async (p: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: any }> => {
      const res = await fetch(`${base}${p}`, {
        method: init.method ?? "GET",
        headers: { "content-type": "application/json", ...(init.headers ?? {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : {} };
    };
    const ch = await call("/session/challenge", { method: "POST", body: { address: env.owner.address } });
    const res = await fetch(`${base}/session/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: env.owner.address, nonce: ch.body.nonce, signature: env.owner.signText(ch.body.message) }),
    });
    const token = /veilo_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]!;
    const csrf = ((await res.json()) as { csrfToken: string }).csrfToken;
    return { call, path, H: { cookie: `veilo_session=${token}`, "x-csrf-token": csrf, origin: ORIGIN } };
  }

  const policy = {
    tier: "bounded_automatic",
    lifetimeTestUsdc: "500000",
    rolling24hTestUsdc: "500000",
    maxPurchaseTestUsdc: "100000",
    taskLimitTestUsdc: "200000",
    usageAllowanceUnits: "0",
    taskCreditUnits: "0",
    allowedSkus: ["analyze"],
    allowedPaymentPaths: ["private_x402"],
  };

  it("provisions on activation and removes on revoke and archive", async () => {
    const { call, path, H } = await start(true);
    const created = await call("/agents", { method: "POST", headers: H, body: { name: "Nova", role: "custom", template: "writer", instructions: "Write notes.", policy } });
    expect(created.status).toBe(201);
    const nova = created.body.agent.id as string;
    expect((await call(`/agents/${nova}/config`, { method: "PATCH", headers: H, body: { activatePolicyVersion: 1 } })).status).toBe(200);
    const entry = read(path).agents.find((a) => a.agentId === nova);
    expect(entry?.role).toBe("custom");
    expect(authenticateWorker(env!.ledger, entry!.token)?.agentId).toBe(nova);

    expect((await call(`/agents/${nova}/revoke`, { method: "POST", headers: H, body: {} })).status).toBe(200);
    expect(read(path).agents.map((a) => a.agentId)).not.toContain(nova);

    const prince = env!.agents.Prince.id;
    expect(read(path).agents.map((a) => a.agentId)).toContain(prince);
    expect((await call(`/agents/${prince}/archive`, { method: "POST", headers: H, body: {} })).status).toBe(200);
    expect(read(path).agents.map((a) => a.agentId)).not.toContain(prince);
  });

  it("provisions on resume", async () => {
    const { call, path, H } = await start(true);
    const mira = env!.agents.Mira.id;
    expect((await call(`/agents/${mira}/pause`, { method: "POST", headers: H, body: {} })).status).toBe(200);
    expect(read.bind(null, path)).toThrow();
    expect((await call(`/agents/${mira}/resume`, { method: "POST", headers: H, body: {} })).status).toBe(200);
    expect(read(path).agents.map((a) => a.agentId).sort()).toEqual([env!.agents.Prince.id, mira].sort());
  });

  it("writes nothing without the opt-in provisioner", async () => {
    const { call, path, H } = await start(false);
    const created = await call("/agents", { method: "POST", headers: H, body: { name: "Nova", role: "custom", template: "writer", instructions: "Write notes.", policy } });
    expect((await call(`/agents/${created.body.agent.id}/config`, { method: "PATCH", headers: H, body: { activatePolicyVersion: 1 } })).status).toBe(200);
    expect(() => statSync(path)).toThrow();
  });
});
