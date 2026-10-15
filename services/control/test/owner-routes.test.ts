import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_TOKEN_MINT, DEVNET_CAIP2, DEVNET_GENESIS_HASH, createServiceHealth, loadConfig } from "@veilo/contracts";
import { createApp } from "../src/app";
import { ServiceCredentials } from "../src/auth/credentials";
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function start(): Promise<{ call: (path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => Promise<{ status: number; body: Json }>; owner: Record<string, string> }> {
  env = createEnv();
  activateDefaults(env);
  const app = createApp(createServiceHealth("control", config, false), {
    ledger: env.ledger,
    session: { domain: "localhost:3000", origin: ORIGIN, chainId: DEVNET_CAIP2, challengeTtlMs: 300_000, sessionTtlMs: 3_600_000, secureCookies: false },
    services: new ServiceCredentials([]),
    log: () => undefined,
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server!.once("listening", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Json) : {} };
  };
  const ch = await call("/session/challenge", { method: "POST", body: { address: env.owner.address } });
  const sig = env.owner.signText(ch.body.message);
  const res = await fetch(`${base}/session/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: env.owner.address, nonce: ch.body.nonce, signature: sig }),
  });
  const token = /veilo_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]!;
  const csrf = ((await res.json()) as Json).csrfToken as string;
  return { call, owner: { cookie: `veilo_session=${token}`, "x-csrf-token": csrf, origin: ORIGIN } };
}

describe("owner task and archive views", () => {
  it("lists tasks and jobs for one agent to the owner only", async () => {
    const { call, owner } = await start();
    const prince = env!.agents.Prince;
    const run = await call(`/agents/${prince.id}/run`, { method: "POST", headers: owner, body: { objective: "Compare devnet RPC providers" } });
    expect(run.status).toBe(202);
    const unauth = await call(`/tasks?agentId=${prince.id}`);
    expect(unauth.status).toBe(401);
    const list = await call(`/tasks?agentId=${prince.id}`, { headers: { cookie: owner.cookie! } });
    expect(list.status).toBe(200);
    expect(list.body.tasks).toHaveLength(1);
    expect(list.body.tasks[0]).toMatchObject({ objective: "Compare devnet RPC providers", state: "queued" });
    expect(list.body.jobs[0]).toMatchObject({ kind: "research", state: "queued", result: null });
    const other = await call(`/tasks?agentId=${env!.agents.Mira.id}`, { headers: { cookie: owner.cookie! } });
    expect(other.body.tasks).toHaveLength(0);
  });

  it("archives an agent by revoking its authority first and keeps its records", async () => {
    const { call, owner } = await start();
    const prince = env!.agents.Prince;
    await call(`/agents/${prince.id}/run`, { method: "POST", headers: owner, body: { objective: "Question" } });
    const noCsrf = await call(`/agents/${prince.id}/archive`, { method: "POST", headers: { cookie: owner.cookie!, origin: ORIGIN }, body: {} });
    expect(noCsrf.status).toBe(403);
    const archived = await call(`/agents/${prince.id}/archive`, { method: "POST", headers: owner, body: {} });
    expect(archived.status).toBe(200);
    expect(archived.body.agent.status).toBe("archived");
    expect(archived.body.agent.revocationEpoch).toBeGreaterThan(0);
    const again = await call(`/agents/${prince.id}/archive`, { method: "POST", headers: owner, body: {} });
    expect(again.body.agent.status).toBe("archived");
    const run = await call(`/agents/${prince.id}/run`, { method: "POST", headers: owner, body: { objective: "More" } });
    expect(run.status).toBe(423);
    const list = await call(`/tasks?agentId=${prince.id}`, { headers: { cookie: owner.cookie! } });
    expect(list.body.tasks).toHaveLength(1);
    expect(list.body.jobs[0].state).toBe("cancelled");
  });
});
