import { describe, expect, it } from "vitest";
import { proxy } from "../lib/server/proxy";
import type { UpstreamConfig } from "../lib/server/upstream";
import { upstreamConfig } from "../lib/server/upstream";

const ORIGIN = "http://localhost:3000";
const config: UpstreamConfig = {
  dashboardOrigin: ORIGIN,
  secureCookies: false,
  baseUrl: { control: "http://127.0.0.1:4101", wallet: "http://127.0.0.1:4103", relayer: "http://127.0.0.1:4105" },
};
const AGENT = "22222222-2222-4222-8222-222222222222";

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

function upstream(reply: (s: Seen) => Response = () => Response.json({ ok: true })) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const s = { url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body as string | undefined };
    seen.push(s);
    return reply(s);
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const req = (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
  new Request(`${ORIGIN}/api/${path}`, {
    method: init.method ?? "GET",
    headers: init.headers ?? {},
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });

describe("dashboard proxy", () => {
  it("forwards the session cookie, CSRF header and dashboard Origin to control, and nothing else", async () => {
    const u = upstream();
    const res = await proxy(
      req(`control/agents/${AGENT}/pause`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
          cookie: "veilo_session=vos_abc; veilo_csrf=tok123; other=secret",
          "x-csrf-token": "tok123",
          authorization: "Bearer stolen-worker-token",
          "x-veilo-owner-session": "vos_injected",
        },
        body: {},
      }),
      "control",
      ["agents", AGENT, "pause"],
      { config, fetchImpl: u.fetchImpl },
    );
    expect(res.status).toBe(200);
    expect(u.seen).toHaveLength(1);
    const s = u.seen[0]!;
    expect(s.url).toBe(`http://127.0.0.1:4101/agents/${AGENT}/pause`);
    expect(s.method).toBe("POST");
    expect(s.headers.get("x-csrf-token")).toBe("tok123");
    expect(s.headers.get("cookie")).toBe("veilo_session=vos_abc");
    expect(s.headers.get("origin")).toBe(ORIGIN);
    expect(s.headers.get("authorization")).toBeNull();
    expect(s.headers.get("x-veilo-owner-session")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("forwards CSRF and session to the wallet service for owner deposits", async () => {
    const u = upstream();
    await proxy(
      req("wallet/deposits/prepare", { method: "POST", headers: { origin: ORIGIN, cookie: "veilo_session=vos_w", "x-csrf-token": "tokW" }, body: { amount: "1000000" } }),
      "wallet",
      ["deposits", "prepare"],
      { config, fetchImpl: u.fetchImpl },
    );
    expect(u.seen[0]!.url).toBe("http://127.0.0.1:4103/deposits/prepare");
    expect(u.seen[0]!.headers.get("x-csrf-token")).toBe("tokW");
    expect(u.seen[0]!.headers.get("cookie")).toBe("veilo_session=vos_w");
    expect(JSON.parse(u.seen[0]!.body!)).toEqual({ amount: "1000000" });
  });

  it("rejects mutating requests without a CSRF header or from another origin before contacting upstream", async () => {
    const u = upstream();
    const noCsrf = await proxy(req("control/workspace/stop", { method: "POST", headers: { origin: ORIGIN, cookie: "veilo_session=vos_x" }, body: {} }), "control", ["workspace", "stop"], {
      config,
      fetchImpl: u.fetchImpl,
    });
    expect(noCsrf.status).toBe(403);
    const crossOrigin = await proxy(
      req("control/workspace/stop", { method: "POST", headers: { origin: "https://evil.example", cookie: "veilo_session=vos_x", "x-csrf-token": "t" }, body: {} }),
      "control",
      ["workspace", "stop"],
      { config, fetchImpl: u.fetchImpl },
    );
    expect(crossOrigin.status).toBe(403);
    const noOrigin = await proxy(req("control/workspace/stop", { method: "POST", headers: { cookie: "veilo_session=vos_x", "x-csrf-token": "t" }, body: {} }), "control", ["workspace", "stop"], {
      config,
      fetchImpl: u.fetchImpl,
    });
    expect(noOrigin.status).toBe(403);
    const crossSite = await proxy(
      req("control/workspace/stop", { method: "POST", headers: { origin: ORIGIN, "sec-fetch-site": "cross-site", "x-csrf-token": "t" }, body: {} }),
      "control",
      ["workspace", "stop"],
      { config, fetchImpl: u.fetchImpl },
    );
    expect(crossSite.status).toBe(403);
    expect(u.seen).toHaveLength(0);
  });

  it("forwards a connector detach as DELETE only with the CSRF header, and passes 204 through", async () => {
    const u = upstream(() => new Response(null, { status: 204 }));
    const path = ["agents", AGENT, "connectors", "solana-developer-docs"];
    const cookie = "veilo_session=vos_abc; veilo_csrf=tok123";
    const refused = await proxy(req(`control/${path.join("/")}`, { method: "DELETE", headers: { origin: ORIGIN, cookie } }), "control", path, { config, fetchImpl: u.fetchImpl });
    expect(refused.status).toBe(403);
    expect(u.seen).toHaveLength(0);
    const res = await proxy(req(`control/${path.join("/")}`, { method: "DELETE", headers: { origin: ORIGIN, cookie, "x-csrf-token": "tok123" } }), "control", path, { config, fetchImpl: u.fetchImpl });
    expect(res.status).toBe(204);
    expect(u.seen.map((s) => [s.method, s.url])).toEqual([["DELETE", `http://127.0.0.1:4101/agents/${AGENT}/connectors/solana-developer-docs`]]);
  });

  it("does not expose worker, internal, credential-issuing or unknown endpoints", async () => {
    const u = upstream();
    const cases: Array<[string, "control" | "wallet" | "relayer", string[]]> = [
      ["GET", "control", ["worker", "catalog"]],
      ["POST", "control", ["worker", "connector-calls"]],
      ["GET", "control", ["worker", "connectors"]],
      ["DELETE", "control", ["agents", AGENT, "connectors", "Bad_Id"]],
      ["POST", "control", ["purchase-intents"]],
      ["POST", "control", ["agents", AGENT, "worker-credentials"]],
      ["GET", "control", ["internal", "wallet", "notes"]],
      ["POST", "wallet", ["fundings"]],
      ["POST", "relayer", ["withdrawals"]],
      ["GET", "control", ["..", "health"]],
      ["GET", "control", ["workspace%2F..%2Fworker"]],
    ];
    for (const [method, service, path] of cases) {
      const res = await proxy(
        req(`${service}/${path.join("/")}`, { method, headers: { origin: ORIGIN, "x-csrf-token": "t" }, ...(method === "POST" ? { body: {} } : {}) }),
        service,
        path,
        { config, fetchImpl: u.fetchImpl },
      );
      expect(res.status, `${method} ${service}/${path.join("/")}`).toBe(404);
    }
    expect(u.seen).toHaveLength(0);
  });

  it("sets the session cookie and a SameSite=Strict CSRF cookie on verify without returning the token in the body", async () => {
    const u = upstream(() => {
      const h = new Headers({ "content-type": "application/json" });
      h.append("set-cookie", "veilo_session=vos_new; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200");
      return new Response(JSON.stringify({ ownerPubkey: "Owner", csrfToken: "csrfTokenValue_0123456789", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }), { status: 200, headers: h });
    });
    const res = await proxy(req("control/session/verify", { method: "POST", headers: { origin: ORIGIN }, body: { address: "a", nonce: "n", signature: "s" } }), "control", ["session", "verify"], {
      config,
      fetchImpl: u.fetchImpl,
    });
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith("veilo_session=vos_new") && c.includes("HttpOnly"))).toBe(true);
    const csrf = cookies.find((c) => c.startsWith("veilo_csrf="))!;
    expect(csrf).toContain("veilo_csrf=csrfTokenValue_0123456789");
    expect(csrf).toContain("SameSite=Strict");
    expect(csrf).not.toContain("HttpOnly");
    expect(await res.json()).not.toHaveProperty("csrfToken");
  });

  it("passes the session role and address through verify", async () => {
    const u = upstream(() =>
      Response.json({ role: "guest", address: "GuestAddr", csrfToken: "csrfTokenValue_0123456789", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
    );
    const res = await proxy(req("control/session/verify", { method: "POST", headers: { origin: ORIGIN }, body: { address: "a", nonce: "n", signature: "s" } }), "control", ["session", "verify"], {
      config,
      fetchImpl: u.fetchImpl,
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ role: "guest", address: "GuestAddr" });
    expect(body).not.toHaveProperty("csrfToken");
    expect(body.ownerPubkey).toBeUndefined();
  });

  it("serves GET /session without CSRF, uncached, with only the documented fields", async () => {
    const u = upstream(() => Response.json({ role: "owner", address: "OwnerAddr", expiresAt: "2026-10-18T00:00:00.000Z", publicView: false, extra: "x" }));
    const res = await proxy(req("control/session", { headers: { cookie: "veilo_session=vos_s; veilo_csrf=c; other=secret" } }), "control", ["session"], { config, fetchImpl: u.fetchImpl });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(u.seen[0]!.url).toBe("http://127.0.0.1:4101/session");
    expect(u.seen[0]!.headers.get("cookie")).toBe("veilo_session=vos_s");
    expect(await res.json()).toEqual({ role: "owner", address: "OwnerAddr", expiresAt: "2026-10-18T00:00:00.000Z", publicView: false });
    expect(res.headers.getSetCookie()).toEqual([]);

    const anon = upstream(() => Response.json({ role: "viewer", address: null, expiresAt: null, publicView: true }));
    const stale = await proxy(req("control/session", { headers: { cookie: "veilo_session=vos_old; veilo_csrf=stale" } }), "control", ["session"], { config, fetchImpl: anon.fetchImpl });
    expect(await stale.json()).toEqual({ role: "viewer", address: null, expiresAt: null, publicView: true });
    expect(stale.headers.getSetCookie().some((c) => c.startsWith("veilo_csrf=;") && c.includes("Max-Age=0"))).toBe(true);
    // Only GET is routed; the session endpoint has no mutating form.
    const post = await proxy(req("control/session", { method: "POST", headers: { origin: ORIGIN, "x-csrf-token": "t" }, body: {} }), "control", ["session"], { config, fetchImpl: anon.fetchImpl });
    expect(post.status).toBe(404);
  });

  it("keeps the anti-CSRF cookie on an unrelated 401 and lets sign-out through without the token", async () => {
    const refused = upstream(() => Response.json({ error: { code: "UNAUTHENTICATED", message: "x" } }, { status: 401 }));
    const res = await proxy(req("control/workspace", { headers: { cookie: "veilo_session=vos_s; veilo_csrf=c" } }), "control", ["workspace"], { config, fetchImpl: refused.fetchImpl });
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual([]);

    const out = upstream(() => new Response(null, { status: 204 }));
    const logout = await proxy(req("control/session/logout", { method: "POST", headers: { origin: ORIGIN, cookie: "veilo_session=vos_s" }, body: {} }), "control", ["session", "logout"], { config, fetchImpl: out.fetchImpl });
    expect(logout.status).toBe(204);
    expect(logout.headers.getSetCookie().some((c) => c.startsWith("veilo_csrf=;"))).toBe(true);
    const foreign = await proxy(req("control/session/logout", { method: "POST", headers: { origin: "https://evil.example", cookie: "veilo_session=vos_s" }, body: {} }), "control", ["session", "logout"], { config, fetchImpl: out.fetchImpl });
    expect(foreign.status).toBe(403);
  });

  it("forwards GET query strings and reports an unreachable service as NOT_READY", async () => {
    const u = upstream();
    await proxy(req(`control/tasks?agentId=${AGENT}&limit=5`), "control", ["tasks"], { config, fetchImpl: u.fetchImpl });
    expect(u.seen[0]!.url).toBe(`http://127.0.0.1:4101/tasks?agentId=${AGENT}&limit=5`);
    const down = await proxy(req("relayer/public-state"), "relayer", ["public-state"], {
      config,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: { code: "NOT_READY", message: "the relayer service is not reachable" } });
  });

  it("routes agent connector reads and mutations, keeping mutations behind Origin and CSRF", async () => {
    const u = upstream((s) => (s.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ attached: [] })));
    const owner = { origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: "veilo_session=vos_o; veilo_csrf=tokO", "x-csrf-token": "tokO" };
    const get = await proxy(req(`control/agents/${AGENT}/connectors`, { headers: { cookie: "veilo_session=vos_o" } }), "control", ["agents", AGENT, "connectors"], { config, fetchImpl: u.fetchImpl });
    expect(get.status).toBe(200);
    const put = await proxy(
      req(`control/agents/${AGENT}/connectors/solana-developer-docs`, { method: "PUT", headers: owner, body: { tools: ["search_docs"] } }),
      "control",
      ["agents", AGENT, "connectors", "solana-developer-docs"],
      { config, fetchImpl: u.fetchImpl },
    );
    expect(put.status).toBe(200);
    const del = await proxy(req(`control/agents/${AGENT}/connectors/meteora-docs`, { method: "DELETE", headers: owner }), "control", ["agents", AGENT, "connectors", "meteora-docs"], {
      config,
      fetchImpl: u.fetchImpl,
    });
    expect(del.status).toBe(204);
    expect(u.seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      `GET http://127.0.0.1:4101/agents/${AGENT}/connectors`,
      `PUT http://127.0.0.1:4101/agents/${AGENT}/connectors/solana-developer-docs`,
      `DELETE http://127.0.0.1:4101/agents/${AGENT}/connectors/meteora-docs`,
    ]);
    expect(JSON.parse(u.seen[1]!.body!)).toEqual({ tools: ["search_docs"] });
    for (const s of u.seen.slice(1)) {
      expect(s.headers.get("x-csrf-token")).toBe("tokO");
      expect(s.headers.get("origin")).toBe(ORIGIN);
      expect(s.headers.get("cookie")).toBe("veilo_session=vos_o");
    }
  });

  it("refuses connector mutations without CSRF or from another origin, and unknown connector paths", async () => {
    const u = upstream();
    const path = ["agents", AGENT, "connectors", "solana-developer-docs"];
    const cases: Array<[string, Record<string, string>]> = [
      ["PUT", { origin: ORIGIN, cookie: "veilo_session=vos_x" }],
      ["DELETE", { origin: ORIGIN, cookie: "veilo_session=vos_x" }],
      ["PUT", { origin: "https://evil.example", "x-csrf-token": "t" }],
      ["DELETE", { origin: ORIGIN, "sec-fetch-site": "cross-site", "x-csrf-token": "t" }],
    ];
    for (const [method, headers] of cases) {
      const res = await proxy(req(`control/${path.join("/")}`, { method, headers, ...(method === "PUT" ? { body: { tools: [] } } : {}) }), "control", path, { config, fetchImpl: u.fetchImpl });
      expect(res.status, `${method} ${JSON.stringify(headers)}`).toBe(403);
    }
    const ok = { origin: ORIGIN, "x-csrf-token": "t" };
    const notRouted: Array<[string, string[]]> = [
      ["PUT", ["agents", AGENT, "connectors", "Bad_ID"]],
      ["PUT", ["agents", AGENT, "connectors", ".."]],
      ["POST", ["agents", AGENT, "connectors", "solana-developer-docs"]],
      ["PATCH", ["agents", AGENT, "connectors"]],
      ["DELETE", ["agents", AGENT, "connectors"]],
      ["DELETE", ["agents", "not-a-uuid", "connectors", "solana-developer-docs"]],
      ["DELETE", ["agents", AGENT]],
    ];
    for (const [method, p] of notRouted) {
      const res = await proxy(req(`control/${p.join("/")}`, { method, headers: ok, ...(method === "DELETE" ? {} : { body: {} }) }), "control", p, { config, fetchImpl: u.fetchImpl });
      expect(res.status, `${method} ${p.join("/")}`).toBe(404);
    }
    expect(u.seen).toHaveLength(0);
  });

  it("passes control's owner-only refusal of a guest's connector change through unchanged", async () => {
    const u = upstream(() => Response.json({ error: { code: "FORBIDDEN", message: "only the workspace owner can change connectors" } }, { status: 403 }));
    const path = ["agents", AGENT, "connectors", "solana-developer-docs"];
    const res = await proxy(
      req(`control/${path.join("/")}`, { method: "PUT", headers: { origin: ORIGIN, cookie: "veilo_session=vgs_guest", "x-csrf-token": "tokG" }, body: { tools: ["search_docs"] } }),
      "control",
      path,
      { config, fetchImpl: u.fetchImpl },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "FORBIDDEN", message: "only the workspace owner can change connectors" } });
    expect(u.seen[0]!.headers.get("cookie")).toBe("veilo_session=vgs_guest");
  });

  it("targets loopback ports from configuration", () => {
    const c = upstreamConfig({ CONTROL_PORT: "5101", VEILO_DASHBOARD_ORIGIN: "http://localhost:3999/" } as unknown as NodeJS.ProcessEnv);
    expect(c.baseUrl.control).toBe("http://127.0.0.1:5101");
    expect(c.baseUrl.wallet).toBe("http://127.0.0.1:4103");
    expect(c.dashboardOrigin).toBe("http://localhost:3999");
  });
});

describe("hosted upstreams", () => {
  it("uses explicit https service URLs and refuses unsafe ones", async () => {
    const { upstreamConfig, upstreamUrl } = await import("../lib/server/upstream");
    const c = upstreamConfig({ VEILO_DASHBOARD_ORIGIN: "https://veilo.vercel.app", VEILO_CONTROL_URL: "https://control.example.com/", VEILO_WALLET_URL: "https://wallet.example.com" } as unknown as NodeJS.ProcessEnv);
    expect(c.baseUrl.control).toBe("https://control.example.com");
    expect(c.baseUrl.wallet).toBe("https://wallet.example.com");
    expect(c.baseUrl.relayer).toBe("http://127.0.0.1:4105");
    expect(c.secureCookies).toBe(true);
    expect(upstreamUrl("X", "http://localhost:4101")).toBe("http://localhost:4101");
    expect(upstreamUrl("X", "https://h.example.com/api/")).toBe("https://h.example.com/api");
    expect(() => upstreamConfig({ VERCEL: "1", VEILO_CONTROL_URL: "https://c.example.com" } as unknown as NodeJS.ProcessEnv)).toThrow(/missing VEILO_DASHBOARD_ORIGIN, VEILO_WALLET_URL, VEILO_RELAYER_URL/);
    const { assertHostedConfig } = await import("../lib/server/upstream-url");
    expect(() => assertHostedConfig({ VEILO_DASHBOARD_ORIGIN: "https://d.example.com", VEILO_CONTROL_URL: "https://c.example.com", VEILO_WALLET_URL: "http://w.example.com", VEILO_RELAYER_URL: "https://r.example.com" } as unknown as NodeJS.ProcessEnv)).toThrow(/VEILO_WALLET_URL/);
    for (const bad of ["https://h.example.com?", "https://h.example.com#", "http://control.example.com", "https://u:p@control.example.com", "https://control.example.com/?k=1", "ftp://control.example.com", "not a url"]) {
      expect(() => upstreamUrl("VEILO_CONTROL_URL", bad), bad).toThrow(/VEILO_CONTROL_URL/);
    }
  });
});
