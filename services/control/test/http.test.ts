import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_TOOLS, FORBIDDEN_AGENT_CAPABILITIES, createServiceHealth, loadConfig, DEMO_TOKEN_MINT, DEVNET_GENESIS_HASH, DEVNET_CAIP2 } from "@veilo/contracts";
import { createApp } from "../src/app";
import { ServiceCredentials } from "../src/auth/credentials";
import type { SessionSettings } from "../src/auth/session";
import { advanceAuthority } from "../src/ledger/purchases";
import { activateDefaults, addNotes, addService, createEnv, digest, testKeypair, type TestEnv } from "./helpers";

const config = loadConfig({
  DEVNET_RPC_URL: "https://rpc.test.invalid",
  EXPECTED_DEVNET_GENESIS_HASH: DEVNET_GENESIS_HASH,
  DEMO_TOKEN_MINT,
  FACILITATOR_URL: "https://facilitator.payai.network",
});

const ORIGIN = "http://localhost:3000";
const WALLET_SECRET = "wallet-service-credential-0123456789abcdef";
const GATEWAY_ADMIN_SECRET = "gateway-admin-credential-0123456789abcdef";

interface Harness {
  env: TestEnv;
  base: string;
  logs: string[];
  server: Server;
  session: SessionSettings;
}

let h: Harness | undefined;
afterEach(async () => {
  if (h) {
    await new Promise<void>((r) => h!.server.close(() => r()));
    h.env.cleanup();
    h = undefined;
  }
});

async function start(opts: { secureCookies?: boolean } = {}): Promise<Harness> {
  const env = createEnv();
  activateDefaults(env);
  const logs: string[] = [];
  const session: SessionSettings = {
    domain: "localhost:3000",
    origin: ORIGIN,
    chainId: DEVNET_CAIP2,
    challengeTtlMs: 5 * 60_000,
    sessionTtlMs: 3_600_000,
    secureCookies: opts.secureCookies ?? false,
  };
  const services = new ServiceCredentials([{ service: "wallet", secret: WALLET_SECRET }]);
  const app = createApp(createServiceHealth("control", config, false), {
    ledger: env.ledger,
    session,
    services,
    log: (l) => logs.push(l),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  h = { env, base: `http://127.0.0.1:${port}`, logs, server, session };
  return h;
}

// Response bodies are inspected loosely in assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

interface Call {
  status: number;
  body: Json;
  headers: Headers;
}

async function call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Call> {
  const res = await fetch(`${h!.base}${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : {}, headers: res.headers };
}

async function login(): Promise<{ cookie: string; csrf: string; setCookie: string; token: string }> {
  const env = h!.env;
  const ch = await call("/session/challenge", { method: "POST", body: { address: env.owner.address } });
  expect(ch.status).toBe(201);
  const signature = env.owner.signText(ch.body.message);
  const v = await call("/session/verify", { method: "POST", body: { address: env.owner.address, nonce: ch.body.nonce, signature } });
  expect(v.status).toBe(200);
  const setCookie = v.headers.get("set-cookie") ?? "";
  const token = /veilo_session=([^;]+)/.exec(setCookie)![1]!;
  return { cookie: `veilo_session=${token}`, csrf: v.body.csrfToken, setCookie, token };
}

const ownerHeaders = (s: { cookie: string; csrf: string }) => ({ cookie: s.cookie, "x-csrf-token": s.csrf, origin: ORIGIN });

async function workerToken(agentId: string, s: { cookie: string; csrf: string }): Promise<string> {
  const r = await call(`/agents/${agentId}/worker-credentials`, { method: "POST", headers: ownerHeaders(s), body: {} });
  expect(r.status).toBe(201);
  return r.body.token as string;
}

describe("owner session", () => {
  it("issues a domain-bound challenge and an httpOnly SameSite=Strict session cookie", async () => {
    await start();
    const ch = await call("/session/challenge", { method: "POST", body: { address: h!.env.owner.address } });
    expect(ch.body.message).toContain("localhost:3000 wants you to sign in");
    expect(ch.body.message).toContain(`Chain ID: ${DEVNET_CAIP2}`);
    expect(ch.body.message).toContain(`Nonce: ${ch.body.nonce}`);
    expect(ch.body.message).toMatch(/Issued At: .*\nExpiration Time: /);
    const s = await login();
    expect(s.setCookie).toMatch(/HttpOnly/);
    expect(s.setCookie).toMatch(/SameSite=Strict/);
    expect(s.setCookie).not.toMatch(/Secure/);
    const ws = await call("/workspace", { headers: { cookie: s.cookie } });
    expect(ws.status).toBe(200);
    expect(ws.body.agents).toHaveLength(3);
  });

  it("marks the cookie Secure when configured for https", async () => {
    await start({ secureCookies: true });
    const s = await login();
    expect(s.setCookie).toMatch(/; Secure/);
  });

  it("rejects a replayed nonce", async () => {
    await start();
    const env = h!.env;
    const ch = await call("/session/challenge", { method: "POST", body: { address: env.owner.address } });
    const body = { address: env.owner.address, nonce: ch.body.nonce, signature: env.owner.signText(ch.body.message) };
    expect((await call("/session/verify", { method: "POST", body })).status).toBe(200);
    const replay = await call("/session/verify", { method: "POST", body });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects an expired challenge", async () => {
    await start();
    const env = h!.env;
    const ch = await call("/session/challenge", { method: "POST", body: { address: env.owner.address } });
    env.clock.t += 5 * 60_000 + 1;
    const r = await call("/session/verify", {
      method: "POST",
      body: { address: env.owner.address, nonce: ch.body.nonce, signature: env.owner.signText(ch.body.message) },
    });
    expect(r.status).toBe(401);
    expect(r.body.error.message).toMatch(/expired/);
  });

  it("rejects a signature over a message bound to another domain", async () => {
    await start();
    const env = h!.env;
    const ch = await call("/session/challenge", { method: "POST", body: { address: env.owner.address } });
    const phished = (ch.body.message as string).replace("localhost:3000 wants", "evil.example wants");
    const sig = env.owner.signText(phished);
    const echoed = await call("/session/verify", { method: "POST", body: { address: env.owner.address, nonce: ch.body.nonce, signature: sig, message: phished } });
    expect(echoed.status).toBe(401);
    expect(echoed.body.error.message).toMatch(/does not match the issued challenge/);
    const ch2 = await call("/session/challenge", { method: "POST", body: { address: env.owner.address } });
    const phished2 = (ch2.body.message as string).replace("localhost:3000 wants", "evil.example wants");
    const bare = await call("/session/verify", { method: "POST", body: { address: env.owner.address, nonce: ch2.body.nonce, signature: env.owner.signText(phished2) } });
    expect(bare.status).toBe(401);
    expect(bare.body.error.message).toMatch(/signature verification failed/);
  });

  it("rejects a wrong signer and non-owner addresses", async () => {
    await start();
    const env = h!.env;
    const attacker = testKeypair();
    const ch = await call("/session/challenge", { method: "POST", body: { address: env.owner.address } });
    const r = await call("/session/verify", { method: "POST", body: { address: env.owner.address, nonce: ch.body.nonce, signature: attacker.signText(ch.body.message) } });
    expect(r.status).toBe(401);
    const other = await call("/session/challenge", { method: "POST", body: { address: attacker.address } });
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe("POLICY_DENIED");
    const bad = await call("/session/challenge", { method: "POST", body: { address: "not-an-address" } });
    expect(bad.status).toBe(400);
  });

  it("requires the anti-CSRF token and same origin for mutating owner requests", async () => {
    await start();
    const s = await login();
    expect((await call("/workspace/stop", { method: "POST", headers: { cookie: s.cookie }, body: {} })).status).toBe(403);
    expect((await call("/workspace/stop", { method: "POST", headers: { cookie: s.cookie, "x-csrf-token": "wrong" }, body: {} })).status).toBe(403);
    const cross = await call("/workspace/stop", { method: "POST", headers: { ...ownerHeaders(s), origin: "https://evil.example" }, body: {} });
    expect(cross.status).toBe(403);
    expect(cross.body.error.code).toBe("FORBIDDEN");
    expect(Number(h!.env.db.prepare("SELECT stopped FROM workspace").pluck().get())).toBe(0);
    const ok = await call("/workspace/stop", { method: "POST", headers: ownerHeaders(s), body: { reason: "drill" } });
    expect(ok.status).toBe(200);
    expect(ok.body.stopped).toBe(true);
  });

  it("rejects unauthenticated and logged-out sessions", async () => {
    await start();
    expect((await call("/workspace")).status).toBe(401);
    const s = await login();
    expect((await call("/session/logout", { method: "POST", headers: ownerHeaders(s), body: {} })).status).toBe(204);
    expect((await call("/workspace", { headers: { cookie: s.cookie } })).status).toBe(401);
  });
});

describe("AUTH-01 agent identity comes from the credential", () => {
  it("rejects another agent's ID and scopes purchase reads to the caller", async () => {
    await start();
    const env = h!.env;
    const s = await login();
    const svc = addService(env, [{ sku: "research-basic", paymentPath: "private_x402", price: 100_000n }, { sku: "analyze", paymentPath: "private_x402", price: 100_000n }]);
    addNotes(env, [100_000n, 100_000n]);
    const prince = await workerToken(env.agents.Prince.id, s);
    const mira = await workerToken(env.agents.Mira.id, s);
    const intent = { idempotencyKey: "k1", serviceId: svc, sku: "research-basic", paymentPath: "private_x402", requestDigest: digest("k1") };

    const spoof = await call("/purchase-intents", { method: "POST", headers: { authorization: `Bearer ${prince}` }, body: { ...intent, agentId: env.agents.Mira.id } });
    expect(spoof.status).toBe(403);
    expect(spoof.body.error.code).toBe("POLICY_DENIED");
    expect(Number(env.db.prepare("SELECT count(*) FROM purchase").pluck().get())).toBe(0);

    const own = await call("/purchase-intents", { method: "POST", headers: { authorization: `Bearer ${prince}` }, body: intent });
    expect(own.status).toBe(201);
    expect(own.body.purchase.agentId).toBe(env.agents.Prince.id);
    const read = await call(`/purchases/${own.body.purchase.id}`, { headers: { authorization: `Bearer ${mira}` } });
    expect(read.status).toBe(403);
    expect(read.body.error.code).toBe("POLICY_DENIED");
    const ownRead = await call(`/purchases/${own.body.purchase.id}`, { headers: { authorization: `Bearer ${prince}` } });
    expect(ownRead.status).toBe(200);

    // Mira's purchase under the same logical key is a separate operation, not Prince's.
    const miraIntent = await call("/purchase-intents", { method: "POST", headers: { authorization: `Bearer ${mira}` }, body: { ...intent, sku: "analyze" } });
    expect(miraIntent.status).toBe(201);
    expect(miraIntent.body.purchase.id).not.toBe(own.body.purchase.id);
  });
});

describe("AUTH-02 worker tools cannot sign, edit policy or publish", () => {
  it("defines no forbidden capability in the agent tool surface", () => {
    for (const tool of AGENT_TOOLS) {
      for (const bad of FORBIDDEN_AGENT_CAPABILITIES) {
        expect(tool.name.toLowerCase()).not.toContain(bad.toLowerCase());
        expect(tool.path.toLowerCase()).not.toContain(bad.toLowerCase());
      }
    }
    expect(AGENT_TOOLS.map((t) => t.name).sort()).toEqual(
      ["budget_summary", "catalog_lookup", "consume_inference_sku", "purchase_status", "request_handoff", "request_purchase", "save_artifact"].sort(),
    );
  });

  it("denies worker credentials on owner, policy and signing surfaces", async () => {
    await start();
    const env = h!.env;
    const s = await login();
    const prince = await workerToken(env.agents.Prince.id, s);
    const auth = { authorization: `Bearer ${prince}` };
    const policy = { tier: "bounded_automatic", lifetimeTestUsdc: "999999999", rolling24hTestUsdc: "999999999", sponsorLamportLimit: "1" };
    const denied: Array<[string, string, unknown]> = [
      ["PATCH", `/agents/${env.agents.Prince.id}/config`, { activatePolicyVersion: 1 }],
      ["POST", "/workspace/policy", { policy, activateVersion: 2 }],
      ["POST", "/agents", { name: "Spawned", role: "research", policy: {} }],
      ["POST", `/agents/${env.agents.Mira.id}/pause`, {}],
      ["POST", `/agents/${env.agents.Prince.id}/worker-credentials`, {}],
      ["POST", "/workspace/stop", {}],
      ["GET", "/balances", undefined],
      ["GET", "/workspace", undefined],
    ];
    for (const [method, path, body] of denied) {
      const r = await call(path, { method, headers: auth, body });
      expect([path, r.status]).toEqual([path, 403]);
      expect(r.body.error.code).toBe("FORBIDDEN");
    }
    for (const path of ["/sign", "/transactions/sign", "/notes", "/keys/export", "/publish", "/withdrawals"]) {
      expect((await call(path, { method: "POST", headers: auth, body: {} })).status).toBe(404);
    }
    expect(Number(env.db.prepare("SELECT count(*) FROM policy WHERE created_by = 'owner'").pluck().get())).toBe(0);
    expect(Number(env.db.prepare("SELECT count(*) FROM agent").pluck().get())).toBe(3);

    for (const tool of AGENT_TOOLS.filter((t) => t.method === "GET" && !t.path.includes(":"))) {
      expect((await call(tool.path, { headers: auth })).status).toBe(200);
    }
  });

  it("separates owner, worker, service and gateway-admin credentials", async () => {
    await start();
    const env = h!.env;
    const s = await login();
    const svc = addService(env, [{ sku: "research-basic", paymentPath: "private_x402", price: 100_000n }]);
    addNotes(env, [100_000n]);
    const prince = await workerToken(env.agents.Prince.id, s);
    const created = await call("/purchase-intents", {
      method: "POST",
      headers: { authorization: `Bearer ${prince}` },
      body: { idempotencyKey: "k", serviceId: svc, sku: "research-basic", paymentPath: "private_x402", requestDigest: digest("k") },
    });
    const id = created.body.purchase.id as string;
    expect((await call(`/purchases/${id}`, { headers: { authorization: `Bearer ${WALLET_SECRET}` } })).status).toBe(200);
    expect((await call(`/purchases/${id}`, { headers: { authorization: `Bearer ${GATEWAY_ADMIN_SECRET}` } })).status).toBe(401);
    expect((await call("/purchase-intents", { method: "POST", headers: { authorization: `Bearer ${WALLET_SECRET}` }, body: {} })).status).toBe(403);
    expect((await call("/workspace", { headers: { authorization: `Bearer ${WALLET_SECRET}` } })).status).toBe(403);
    // Session cookies are not bearer credentials.
    expect((await call("/workspace", { headers: { authorization: `Bearer ${s.token}` } })).status).toBe(401);

    await call(`/agents/${env.agents.Prince.id}/revoke`, { method: "POST", headers: ownerHeaders(s), body: {} });
    expect((await call("/worker/budget", { headers: { authorization: `Bearer ${prince}` } })).status).toBe(401);
  });
});

describe("control API", () => {
  it("serves the owner and purchase endpoints with shared schemas", async () => {
    await start();
    const env = h!.env;
    const s = await login();
    const H = ownerHeaders(s);

    const agent = await call("/agents", {
      method: "POST",
      headers: H,
      body: {
        name: "Nova",
        role: "research",
        policy: {
          tier: "bounded_automatic",
          lifetimeTestUsdc: "500000",
          rolling24hTestUsdc: "500000",
          maxPurchaseTestUsdc: "100000",
          taskLimitTestUsdc: "200000",
          usageAllowanceUnits: "0",
          taskCreditUnits: "0",
          allowedSkus: ["research-basic"],
          allowedPaymentPaths: ["private_x402"],
        },
      },
    });
    expect(agent.status).toBe(201);
    expect(agent.body.agent.status).toBe("draft");
    const novaId = agent.body.agent.id as string;
    const activated = await call(`/agents/${novaId}/config`, { method: "PATCH", headers: H, body: { activatePolicyVersion: 1 } });
    expect(activated.status).toBe(200);
    expect(activated.body.agent.status).toBe("active");

    const floaty = await call(`/agents/${novaId}/config`, {
      method: "PATCH",
      headers: H,
      body: { policy: { ...agent.body.agent.activePolicy, lifetimeTestUsdc: 1.5 } },
    });
    expect(floaty.status).toBe(400);
    for (const bad of [1500000, "1.5", "1e6", "-1", "01", " 1"]) {
      const r = await call("/workspace/policy", {
        method: "POST",
        headers: H,
        body: { policy: { tier: "bounded_automatic", lifetimeTestUsdc: bad, rolling24hTestUsdc: "1", sponsorLamportLimit: "1" } },
      });
      expect([bad, r.status, r.body.error.code]).toEqual([bad, 400, "INVALID_REQUEST"]);
    }
    const wsPolicy = await call("/workspace/policy", {
      method: "POST",
      headers: H,
      body: { policy: { tier: "bounded_automatic", lifetimeTestUsdc: "9000000", rolling24hTestUsdc: "4000000", sponsorLamportLimit: "100000000" }, activateVersion: 2 },
    });
    expect(wsPolicy.status).toBe(201);
    expect(wsPolicy.body.activated.version).toBe(2);

    const run1 = await call(`/agents/${env.agents.Prince.id}/run`, { method: "POST", headers: H, body: { objective: "Compare data vendors", triggerKey: "brief-1" } });
    expect(run1.status).toBe(202);
    expect(run1.body.job.state).toBe("queued");
    const run2 = await call(`/agents/${env.agents.Prince.id}/run`, { method: "POST", headers: H, body: { objective: "Compare data vendors", triggerKey: "brief-1" } });
    expect(run2.status).toBe(200);
    expect(run2.body.job.id).toBe(run1.body.job.id);
    const shawnRun = await call(`/agents/${env.agents.Shawn.id}/run`, { method: "POST", headers: H, body: {} });
    expect(shawnRun.body.job.kind).toBe("credit_check");

    const svc = addService(env, [{ sku: "research-basic", paymentPath: "private_x402", price: 100_000n }]);
    addNotes(env, [100_000n, 100_000n]);
    const prince = await workerToken(env.agents.Prince.id, s);
    const W = { authorization: `Bearer ${prince}` };
    const intent = { idempotencyKey: "brief-1:data", serviceId: svc, sku: "research-basic", paymentPath: "private_x402", requestDigest: digest("data"), taskId: run1.body.taskId };
    const p1 = await call("/purchase-intents", { method: "POST", headers: W, body: intent });
    expect(p1.status).toBe(201);
    expect(p1.body.purchase.label).toBe("Reserved");
    expect(p1.body.purchase.price).toEqual({ amount: "100000", unit: "usdc_base_units" });
    const p1again = await call("/purchase-intents", { method: "POST", headers: W, body: intent });
    expect(p1again.status).toBe(200);
    expect(p1again.body.purchase.operationId).toBe(p1.body.purchase.operationId);
    const conflict = await call("/purchase-intents", { method: "POST", headers: W, body: { ...intent, requestDigest: digest("other") } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("IDEMPOTENCY_CONFLICT");

    const recon = await call(`/purchases/${p1.body.purchase.id}/reconcile`, { method: "POST", headers: H, body: {} });
    expect(recon.status).toBe(200);
    expect(recon.body.changed).toBe(false);
    advanceAuthority(env.ledger, p1.body.purchase.id, "prepare_proof");
    advanceAuthority(env.ledger, p1.body.purchase.id, "release_proof");
    const notReady = await call(`/purchases/${p1.body.purchase.id}/reconcile`, { method: "POST", headers: { authorization: `Bearer ${WALLET_SECRET}` }, body: {} });
    expect(notReady.status).toBe(503);
    expect(notReady.body.error.code).toBe("NOT_READY");

    const balances = await call("/balances", { headers: { cookie: s.cookie } });
    expect(balances.status).toBe(200);
    expect(balances.body.gatewayCredits).toMatchObject({ available: false, code: "NOT_READY" });
    expect(balances.body.tokens.buckets.reserved_input).toBe("100000");
    expect(balances.body.workspace.lifetime.reserved).toBe("100000");

    const budget = await call("/worker/budget", { headers: W });
    expect(budget.body.lifetime.reserved).toBe("100000");
    const catalog = await call("/worker/catalog", { headers: W });
    expect(catalog.body.items.every((i: { sku: string }) => ["research-basic", "research-expanded", "summarize", "analyze"].includes(i.sku))).toBe(true);
    const art = await call("/worker/artifacts", {
      method: "POST",
      headers: W,
      body: { taskId: run1.body.taskId, kind: "research_brief", title: "Brief", content: "Draft", citations: [{ url: "https://example.org/a" }], sourcePurchaseIds: [p1.body.purchase.id] },
    });
    expect(art.status).toBe(201);
    const handoff = await call("/worker/handoffs", { method: "POST", headers: W, body: { artifactId: art.body.id, toAgentId: env.agents.Mira.id } });
    expect(handoff.body.state).toBe("pending_owner");

    const pause = await call(`/agents/${env.agents.Prince.id}/pause`, { method: "POST", headers: H, body: {} });
    expect(pause.body.agent.status).toBe("paused");
    const blocked = await call("/purchase-intents", { method: "POST", headers: W, body: { ...intent, idempotencyKey: "after-pause" } });
    expect(blocked.status).toBe(423);
    expect(blocked.body.error.code).toBe("ACCOUNT_STOPPED");

    const activity = await call("/activity?limit=100", { headers: { cookie: s.cookie } });
    expect(activity.status).toBe(200);
    const actions = (activity.body.events as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["session.verify", "agent.create", "policy.activate", "purchase.authorize", "agent.pause"]));
  });
});

describe("SEC-02 logs and audit contain no secret material", () => {
  it("never writes tokens, CSRF secrets, service credentials or key bytes to logs, audit or outbox", async () => {
    await start();
    const env = h!.env;
    const s = await login();
    const svc = addService(env, [{ sku: "research-basic", paymentPath: "private_x402", price: 100_000n }]);
    addNotes(env, [100_000n]);
    const prince = await workerToken(env.agents.Prince.id, s);
    await call("/purchase-intents", {
      method: "POST",
      headers: { authorization: `Bearer ${prince}` },
      body: { idempotencyKey: "x", serviceId: svc, sku: "research-basic", paymentPath: "private_x402", requestDigest: digest("x"), rationale: `token ${prince}` },
    });
    await call("/purchase-intents", { method: "POST", headers: { authorization: `Bearer ${prince}` }, body: { agentId: env.agents.Mira.id } });
    await call("/workspace", { headers: { authorization: `Bearer ${GATEWAY_ADMIN_SECRET}` } });
    await call(`/purchases/${env.agents.Mira.id}`, { headers: { authorization: `Bearer ${WALLET_SECRET}` } });
    await call("/workspace/stop", { method: "POST", headers: { cookie: s.cookie, "x-csrf-token": "guess" }, body: {} });

    const persisted = [
      ...(env.db.prepare("SELECT details_json FROM audit_event").pluck().all() as string[]),
      ...(env.db.prepare("SELECT payload_json FROM outbox").pluck().all() as string[]),
      ...(env.db.prepare("SELECT ifnull(rationale, '') FROM purchase").pluck().all() as string[]),
    ];
    const haystack = [...h!.logs, ...persisted].join("\n");
    const secrets = [
      s.token,
      s.csrf,
      prince,
      WALLET_SECRET,
      GATEWAY_ADMIN_SECRET,
      env.owner.secretBytes.toString("hex"),
      env.owner.secretBytes.toString("base64"),
      env.owner.secretBytes.toString("base64url"),
    ];
    for (const secret of secrets) expect(haystack.includes(secret)).toBe(false);
    expect(haystack).not.toMatch(/vos_|vwk_/);
    expect(h!.logs.length).toBeGreaterThan(5);
    expect(h!.logs.every((l) => /^\[control\] (GET|POST|PATCH) \/\S* \d{3} \d+ms$/.test(l))).toBe(true);
    // Only digests of bearer values are stored.
    const stored = env.db.prepare("SELECT token_hash FROM worker_credential UNION ALL SELECT token_hash FROM owner_session").pluck().all() as string[];
    expect(stored.every((v) => /^[0-9a-f]{64}$/.test(v))).toBe(true);
  });
});
