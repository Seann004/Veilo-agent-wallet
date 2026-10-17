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

  it("does not expose worker, internal, credential-issuing or unknown endpoints", async () => {
    const u = upstream();
    const cases: Array<[string, "control" | "wallet" | "relayer", string[]]> = [
      ["GET", "control", ["worker", "catalog"]],
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

  it("targets loopback ports from configuration", () => {
    const c = upstreamConfig({ CONTROL_PORT: "5101", VEILO_DASHBOARD_ORIGIN: "http://localhost:3999/" } as unknown as NodeJS.ProcessEnv);
    expect(c.baseUrl.control).toBe("http://127.0.0.1:5101");
    expect(c.baseUrl.wallet).toBe("http://127.0.0.1:4103");
    expect(c.dashboardOrigin).toBe("http://localhost:3999");
  });
});
