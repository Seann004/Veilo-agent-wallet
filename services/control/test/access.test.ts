import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_TOKEN_MINT, DEVNET_CAIP2, DEVNET_GENESIS_HASH, VeiloConfigError, createServiceHealth, loadConfig } from "@veilo/contracts";
import { createApp } from "../src/app";
import { parseGuestPubkeys, parseGuestRunsPerHour, parsePublicView } from "../src/auth/access-config";
import { ServiceCredentials } from "../src/auth/credentials";
import type { SessionSettings } from "../src/auth/session";
import { redactActivityEvents, redactBalances } from "../src/http/redact";
import { advanceAuthority } from "../src/ledger/purchases";
import { activateDefaults, addNotes, addService, createEnv, digest, testKeypair, type TestEnv, type TestKeypair } from "./helpers";

const config = loadConfig({
  DEVNET_RPC_URL: "https://rpc.test.invalid",
  EXPECTED_DEVNET_GENESIS_HASH: DEVNET_GENESIS_HASH,
  DEMO_TOKEN_MINT,
  FACILITATOR_URL: "https://facilitator.payai.network",
});

const ORIGIN = "http://localhost:3000";
const WALLET_SECRET = "wallet-service-credential-0123456789abcdef";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

interface Harness {
  env: TestEnv;
  base: string;
  server: Server;
  session: SessionSettings;
  guest: TestKeypair;
}

let h: Harness | undefined;
afterEach(async () => {
  if (h) {
    await new Promise<void>((r) => h!.server.close(() => r()));
    h.env.cleanup();
    h = undefined;
  }
});

async function start(opts: { publicView?: boolean; guestRunsPerHour?: number; noGuests?: boolean } = {}): Promise<Harness> {
  const env = createEnv();
  activateDefaults(env);
  const guest = testKeypair();
  const session: SessionSettings = {
    domain: "localhost:3000",
    origin: ORIGIN,
    chainId: DEVNET_CAIP2,
    challengeTtlMs: 5 * 60_000,
    sessionTtlMs: 12 * 3_600_000,
    secureCookies: false,
    guestPubkeys: opts.noGuests ? [] : [guest.address],
    publicView: opts.publicView ?? false,
    ...(opts.guestRunsPerHour !== undefined ? { guestRunsPerHour: opts.guestRunsPerHour } : {}),
  };
  const app = createApp(createServiceHealth("control", config, false), {
    ledger: env.ledger,
    session,
    services: new ServiceCredentials([{ service: "wallet", secret: WALLET_SECRET }]),
    log: () => undefined,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  h = { env, base: `http://127.0.0.1:${port}`, server, session, guest };
  return h;
}

async function call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: Json; headers: Headers }> {
  const res = await fetch(`${h!.base}${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : {}, headers: res.headers };
}

interface Signed {
  cookie: string;
  csrf: string;
  token: string;
  verify: Json;
  message: string;
}

async function signIn(kp: TestKeypair): Promise<Signed> {
  const ch = await call("/session/challenge", { method: "POST", body: { address: kp.address } });
  expect(ch.status).toBe(201);
  const v = await call("/session/verify", { method: "POST", body: { address: kp.address, nonce: ch.body.nonce, signature: kp.signText(ch.body.message) } });
  expect(v.status).toBe(200);
  const token = /veilo_session=([^;]+)/.exec(v.headers.get("set-cookie") ?? "")![1]!;
  return { cookie: `veilo_session=${token}`, csrf: v.body.csrfToken, token, verify: v.body, message: ch.body.message };
}

const auth = (s: Signed) => ({ cookie: s.cookie, "x-csrf-token": s.csrf, origin: ORIGIN });

/** Workspace state that owner-only routes would change; compared before and after denied calls. */
function snapshot(env: TestEnv): string {
  const q = (sql: string) => JSON.stringify(env.db.prepare(sql).all(), (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  return [
    q("SELECT stopped, emergency_stop_epoch, policy_version FROM workspace"),
    q("SELECT id, name, status, revocation_epoch, policy_version, description FROM agent ORDER BY id"),
    q("SELECT id, version, status FROM policy ORDER BY id"),
    q("SELECT count(*) AS n FROM worker_credential"),
    q("SELECT id, authorization_state, funding_state FROM purchase ORDER BY id"),
    q("SELECT count(*) AS n FROM job"),
    q("SELECT count(*) AS n FROM task"),
  ].join("\n");
}

const READS = ["/workspace", "/activity?limit=50", "/balances", "/tasks", "/content", "/calendar", "/handoffs"];
const UUID = "33333333-3333-4333-8333-333333333333";

function ownerOnlyRoutes(env: TestEnv): Array<[string, string, unknown]> {
  const prince = env.agents.Prince.id;
  const policy = { tier: "bounded_automatic", lifetimeTestUsdc: "1", rolling24hTestUsdc: "1", sponsorLamportLimit: "1" };
  return [
    ["POST", "/workspace/stop", { reason: "guest" }],
    ["POST", "/workspace/resume", {}],
    ["POST", "/workspace/policy", { policy, activateVersion: 1 }],
    ["POST", "/agents", { name: "Spawned", role: "research", policy: {} }],
    ["PATCH", `/agents/${prince}/config`, { name: "Renamed" }],
    ["POST", `/agents/${prince}/pause`, {}],
    ["POST", `/agents/${prince}/resume`, {}],
    ["POST", `/agents/${prince}/revoke`, {}],
    ["POST", `/agents/${prince}/archive`, {}],
    ["POST", `/agents/${prince}/worker-credentials`, {}],
    ["POST", `/purchases/${UUID}/decision`, { decision: "approve" }],
    ["POST", `/purchases/${UUID}/reconcile`, {}],
    ["PATCH", `/content/${UUID}`, { body: "x" }],
    ["POST", `/content/${UUID}/review`, { state: "approved" }],
    ["POST", `/handoffs/${UUID}/decision`, { decision: "approve" }],
  ];
}

describe("access configuration", () => {
  it("validates guest keys, public view and the guest run limit fail-closed", () => {
    const owner = testKeypair().address;
    const a = testKeypair().address;
    const b = testKeypair().address;
    expect(parseGuestPubkeys(undefined, owner)).toEqual([]);
    expect(parseGuestPubkeys(` ${a}, ${b} ,${a}`, owner)).toEqual([a, b]);
    expect(() => parseGuestPubkeys(`${a},not-an-address`, owner)).toThrow(VeiloConfigError);
    expect(() => parseGuestPubkeys(`${a},${owner}`, owner)).toThrow(/owner/);
    expect(parsePublicView(undefined)).toBe(false);
    expect(parsePublicView("0")).toBe(false);
    expect(parsePublicView("1")).toBe(true);
    expect(() => parsePublicView("yes")).toThrow(VeiloConfigError);
    expect(parseGuestRunsPerHour(undefined)).toBe(20);
    expect(parseGuestRunsPerHour("5")).toBe(5);
    for (const bad of ["0", "-1", "1.5", "abc", "100000"]) expect(() => parseGuestRunsPerHour(bad)).toThrow(VeiloConfigError);
  });
});

describe("viewer redaction helpers", () => {
  it("removes the gateway account id and non-allowlisted details", () => {
    const balances = { tokens: { unit: "x", buckets: { private_spendable: "700" } }, gatewayCredits: { available: true, accountId: "acct_secretish", usable: "5" } };
    const out = redactBalances(balances);
    expect(out.gatewayCredits).toEqual({ available: true, usable: "5" });
    expect(out.tokens).toEqual({ unit: "x" });
    expect(balances.tokens.buckets.private_spendable).toBe("700");
    expect(balances.gatewayCredits.accountId).toBe("acct_secretish");
    const events = redactActivityEvents([
      { scope: "session", action: "session.verify", details: { sessionId: "s" } },
      { scope: "agent:a", action: "worker_credential.issue", details: { credentialId: "c" } },
      { scope: "purchase:p", action: "purchase.authorize", details: { sku: "summarize", purchaseId: "p", operationId: "op", reason: "ok" } },
    ]);
    expect(events).toEqual([{ scope: "purchase:p", action: "purchase.authorize", details: { sku: "summarize", reason: "ok" } }]);
  });
});

describe("public view disabled", () => {
  it("keeps anonymous reads unauthenticated and reports no role", async () => {
    await start();
    for (const path of READS) expect([path, (await call(path)).status]).toEqual([path, 401]);
    const s = await call("/session");
    expect(s.status).toBe(200);
    expect(s.headers.get("cache-control")).toBe("no-store");
    expect(s.body).toEqual({ role: "none", address: null, expiresAt: null, publicView: false });
  });
});

describe("public viewer", () => {
  it("serves every read and rejects every mutation without changing state", async () => {
    const { env } = await start({ publicView: true });
    const session = await call("/session");
    expect(session.body).toEqual({ role: "viewer", address: null, expiresAt: null, publicView: true });
    for (const path of READS) expect([path, (await call(path)).status]).toEqual([path, 200]);

    const before = snapshot(env);
    const mutations: Array<[string, string, unknown]> = [
      ...ownerOnlyRoutes(env),
      ["POST", `/agents/${env.agents.Prince.id}/run`, { objective: "Viewer run" }],
      ["POST", "/session/logout", {}],
    ];
    for (const [method, path, body] of mutations) {
      const r = await call(path, { method, body, headers: { origin: ORIGIN } });
      expect([method, path, r.status]).toEqual([method, path, 401]);
    }
    expect(snapshot(env)).toBe(before);
  });

  it("does not downgrade an invalid bearer token to a viewer, but treats a stale cookie as one", async () => {
    await start({ publicView: true });
    expect((await call("/workspace", { headers: { authorization: "Bearer vwk_not-a-real-token" } })).status).toBe(401);
    expect((await call("/workspace", { headers: { authorization: "Basic abc" } })).status).toBe(401);
    const stale = await call("/workspace", { headers: { cookie: "veilo_session=vos_stale" } });
    expect(stale.status).toBe(200);
    expect((await call("/session", { headers: { cookie: "veilo_session=vos_stale" } })).body.role).toBe("viewer");
  });

  it("redacts session events, worker-credential events, operation identifiers and the gateway account", async () => {
    const { env } = await start({ publicView: true });
    const owner = await signIn(env.owner);
    const svc = addService(env, [{ sku: "research-basic", paymentPath: "private_x402", price: 100_000n }]);
    addNotes(env, [100_000n]);
    const tokenRes = await call(`/agents/${env.agents.Prince.id}/worker-credentials`, { method: "POST", headers: auth(owner), body: {} });
    const prince = tokenRes.body.token as string;
    const intent = await call("/purchase-intents", {
      method: "POST",
      headers: { authorization: `Bearer ${prince}` },
      body: { idempotencyKey: "v1", serviceId: svc, sku: "research-basic", paymentPath: "private_x402", requestDigest: digest("v1"), rationale: "compare" },
    });
    expect(intent.status).toBe(201);
    const purchaseId = intent.body.purchase.id as string;
    advanceAuthority(env.ledger, purchaseId, "prepare_proof");

    const ownerView = await call("/activity?limit=100", { headers: { cookie: owner.cookie } });
    expect(ownerView.body.events.some((e: Json) => e.scope === "session")).toBe(true);
    expect(ownerView.body.events.some((e: Json) => String(e.action).startsWith("worker_credential."))).toBe(true);
    expect(ownerView.body.purchases[0]).toHaveProperty("operationId");

    const viewer = await call("/activity?limit=100");
    expect(viewer.status).toBe(200);
    const events = viewer.body.events as Json[];
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.scope === "session")).toBe(false);
    expect(events.some((e) => String(e.action).startsWith("worker_credential."))).toBe(false);
    const allowed = new Set(["role", "sku", "paymentPath", "kind", "revision", "reviewState", "from", "to", "version", "tier", "toAgentId", "artifactId", "taskId", "reason"]);
    for (const e of events) for (const k of Object.keys(e.details)) expect(allowed.has(k)).toBe(true);
    for (const p of viewer.body.purchases as Json[]) {
      for (const k of ["chainAttempts", "operationId", "requestDigest", "stateReason", "execution"]) expect(p).not.toHaveProperty(k);
      expect(p.sku).toBe("research-basic");
    }
    const one = await call(`/purchases/${purchaseId}`);
    expect(one.status).toBe(200);
    for (const k of ["chainAttempts", "operationId", "requestDigest", "stateReason", "execution"]) expect(one.body.purchase).not.toHaveProperty(k);
    expect(one.body).not.toHaveProperty("execution");
    expect(JSON.stringify(viewer.body)).not.toContain(intent.body.purchase.operationId as string);
    expect(JSON.stringify(viewer.body)).not.toContain(digest("v1"));

    const balances = await call("/balances");
    expect(balances.status).toBe(200);
    expect(balances.body.gatewayCredits).not.toHaveProperty("accountId");
    expect(balances.body.tokens).not.toHaveProperty("buckets");
  });
});

describe("guest sessions", () => {
  it("issues a guest-specific SIWS challenge, verifies it and reports the guest role", async () => {
    const { guest, env } = await start();
    const ch = await call("/session/challenge", { method: "POST", body: { address: guest.address } });
    expect(ch.status).toBe(201);
    expect(ch.body.role).toBe("guest");
    expect(ch.body.message).toContain("Sign in to the Veilo workspace as a guest. This signature does not authorize any transaction.");
    expect(ch.body.message).not.toContain("owner workspace");
    expect(ch.body.message).toContain("Chain ID: devnet\n");
    expect(ch.body.message).toMatch(/Nonce: [0-9a-f]{48}\n/);
    const ownerCh = await call("/session/challenge", { method: "POST", body: { address: env.owner.address } });
    expect(ownerCh.body.message).toContain("Sign in to the Veilo owner workspace.");
    expect(ownerCh.body.role).toBe("owner");

    const g = await signIn(guest);
    expect(g.verify).toMatchObject({ role: "guest", address: guest.address });
    expect(g.verify).not.toHaveProperty("ownerPubkey");
    const session = await call("/session", { headers: { cookie: g.cookie } });
    expect(session.body).toMatchObject({ role: "guest", address: guest.address, publicView: false });
    expect(Date.parse(session.body.expiresAt)).toBeGreaterThan(env.clock.t);
    expect(JSON.stringify(session.body)).not.toContain(g.csrf);
    const o = await signIn(env.owner);
    expect(o.verify).toMatchObject({ role: "owner", address: env.owner.address, ownerPubkey: env.owner.address });
    expect((await call("/session", { headers: { cookie: o.cookie } })).body.role).toBe("owner");

    const audit = env.db
      .prepare(`SELECT actor_type, details_json FROM audit_event WHERE action = 'session.verify' AND actor_id = ?`)
      .all(guest.address) as Array<{ actor_type: string; details_json: string }>;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_type).toBe("system");
    expect(JSON.parse(audit[0]!.details_json)).toMatchObject({ actor: "guest" });

    expect((await call("/session/challenge", { method: "POST", body: { address: testKeypair().address } })).status).toBe(403);
  });

  it("gives guests unredacted reads", async () => {
    const { guest } = await start();
    const g = await signIn(guest);
    for (const path of READS) expect([path, (await call(path, { headers: { cookie: g.cookie } })).status]).toEqual([path, 200]);
    const activity = await call("/activity?limit=100", { headers: { cookie: g.cookie } });
    expect(activity.body.events.some((e: Json) => e.scope === "session")).toBe(true);
  });

  it("rejects guests on every owner-only route without changing state", async () => {
    const { guest, env } = await start();
    const g = await signIn(guest);
    const before = snapshot(env);
    for (const [method, path, body] of ownerOnlyRoutes(env)) {
      const r = await call(path, { method, body, headers: auth(g) });
      expect([method, path, r.status, r.body.error?.code]).toEqual([method, path, 403, "FORBIDDEN"]);
    }
    expect(snapshot(env)).toBe(before);
  });

  it("lets guests run agents with CSRF, audits each run and refuses task spending limits", async () => {
    const { guest, env } = await start();
    const g = await signIn(guest);
    const prince = env.agents.Prince.id;
    const noCsrf = await call(`/agents/${prince}/run`, { method: "POST", headers: { cookie: g.cookie, origin: ORIGIN }, body: { objective: "Compare RPCs" } });
    expect(noCsrf.status).toBe(403);
    const cross = await call(`/agents/${prince}/run`, { method: "POST", headers: { ...auth(g), origin: "https://evil.example" }, body: { objective: "Compare RPCs" } });
    expect(cross.status).toBe(403);
    expect(Number(env.db.prepare("SELECT count(*) FROM job").pluck().get())).toBe(0);

    const limited = await call(`/agents/${prince}/run`, { method: "POST", headers: auth(g), body: { objective: "Compare RPCs", taskLimitTestUsdc: "999999999" } });
    expect(limited.status).toBe(403);
    expect(limited.body.error.code).toBe("POLICY_DENIED");
    expect(Number(env.db.prepare("SELECT count(*) FROM task").pluck().get())).toBe(0);

    const handoff = await call(`/agents/${prince}/run`, { method: "POST", headers: auth(g), body: { objective: "Rewrite it", input: { handoffId: "h1" } } });
    expect(handoff.status).toBe(403);
    expect(handoff.body.error.code).toBe("POLICY_DENIED");
    expect(Number(env.db.prepare("SELECT count(*) FROM task").pluck().get())).toBe(0);

    const ok = await call(`/agents/${prince}/run`, { method: "POST", headers: auth(g), body: { objective: "Compare RPCs" } });
    expect(ok.status).toBe(202);
    expect(ok.body.job.state).toBe("queued");
    const credit = await call(`/agents/${env.agents.Shawn.id}/run`, { method: "POST", headers: auth(g), body: {} });
    expect(credit.body.job.kind).toBe("credit_check");

    const runs = env.db
      .prepare(`SELECT actor_type, policy_result, details_json FROM audit_event WHERE action = 'agent.run' AND actor_id = ? ORDER BY seq`)
      .all(guest.address) as Array<{ actor_type: string; policy_result: string; details_json: string }>;
    expect(runs.map((r) => [r.actor_type, r.policy_result])).toEqual([
      ["system", "denied"],
      ["system", "denied"],
      ["system", "allowed"],
      ["system", "allowed"],
    ]);
    expect(JSON.parse(runs[2]!.details_json)).toMatchObject({ actor: "guest", jobId: ok.body.job.id, role: "research" });
  });

  it("rate-limits guest runs per wallet per rolling hour", async () => {
    const { guest, env } = await start({ guestRunsPerHour: 2 });
    const g = await signIn(guest);
    const owner = await signIn(env.owner);
    const prince = env.agents.Prince.id;
    for (let i = 0; i < 2; i++) {
      expect((await call(`/agents/${prince}/run`, { method: "POST", headers: auth(g), body: { objective: `Run ${i}` } })).status).toBe(202);
    }
    const third = await call(`/agents/${prince}/run`, { method: "POST", headers: auth(g), body: { objective: "Run 3" } });
    expect(third.status).toBe(403);
    expect(third.body.error.message).toMatch(/limit/);
    expect(Number(env.db.prepare("SELECT count(*) FROM job").pluck().get())).toBe(2);
    // The owner is not subject to the guest limit.
    expect((await call(`/agents/${prince}/run`, { method: "POST", headers: auth(owner), body: { objective: "Owner run" } })).status).toBe(202);
    env.clock.t += 3_600_001;
    expect((await call(`/agents/${prince}/run`, { method: "POST", headers: auth(g), body: { objective: "Next hour" } })).status).toBe(202);
  });

  it("logs a guest out and invalidates sessions of wallets removed from the guest list", async () => {
    const { guest, env, session } = await start();
    const g = await signIn(guest);
    expect((await call("/workspace", { headers: { cookie: g.cookie } })).status).toBe(200);
    (session as { guestPubkeys?: readonly string[] }).guestPubkeys = [];
    expect((await call("/workspace", { headers: { cookie: g.cookie } })).status).toBe(401);
    expect((await call("/session", { headers: { cookie: g.cookie } })).body.role).toBe("none");
    (session as { guestPubkeys?: readonly string[] }).guestPubkeys = [guest.address];
    expect((await call("/session/logout", { method: "POST", headers: auth(g), body: {} })).status).toBe(204);
    expect((await call("/workspace", { headers: { cookie: g.cookie } })).status).toBe(401);
    const owner = await signIn(env.owner);
    expect((await call("/workspace", { headers: { cookie: owner.cookie } })).status).toBe(200);
  });

  it("refuses a guest challenge verified after the wallet was removed", async () => {
    const { guest, session } = await start();
    const ch = await call("/session/challenge", { method: "POST", body: { address: guest.address } });
    (session as { guestPubkeys?: readonly string[] }).guestPubkeys = [];
    const v = await call("/session/verify", { method: "POST", body: { address: guest.address, nonce: ch.body.nonce, signature: guest.signText(ch.body.message) } });
    expect(v.status).toBe(403);
    expect(v.headers.get("set-cookie")).toBeNull();
  });
});

describe("wallet owner-session resolution", () => {
  it("resolves owner sessions and rejects guest sessions", async () => {
    const { guest, env } = await start();
    const g = await signIn(guest);
    const o = await signIn(env.owner);
    const W = { authorization: `Bearer ${WALLET_SECRET}` };
    const guestRes = await call("/internal/wallet/owner-session", { method: "POST", headers: W, body: { sessionToken: g.token, csrfToken: g.csrf } });
    expect(guestRes.status).toBe(403);
    expect(guestRes.body).not.toHaveProperty("ownerPubkey");
    const ownerRes = await call("/internal/wallet/owner-session", { method: "POST", headers: W, body: { sessionToken: o.token, csrfToken: o.csrf } });
    expect(ownerRes.status).toBe(200);
    expect(ownerRes.body).toMatchObject({ ownerPubkey: env.owner.address, csrfValid: true });
    // A guest cookie presented directly is not a service credential either.
    expect((await call("/internal/wallet/notes", { headers: { cookie: g.cookie } })).status).toBe(403);
  });
});
