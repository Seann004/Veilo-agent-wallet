import "server-only";
import { upstreamConfig, type UpstreamConfig, type UpstreamService } from "./upstream";

export const SESSION_COOKIE = "veilo_session";
/** Readable by dashboard scripts only (SameSite=Strict); echoed back in the x-csrf-token header. */
export const CSRF_COOKIE = "veilo_csrf";
export const CSRF_HEADER = "x-csrf-token";

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
interface Route {
  method: Method;
  path: RegExp;
  /** Session bootstrap: no session or CSRF token exists yet. */
  public?: boolean;
}

const ID = "[0-9a-f-]{36}";
const CONNECTOR = "[a-z0-9][a-z0-9-]{2,62}";
const r = (method: Method, path: string, extra: Partial<Route> = {}): Route => ({ method, path: new RegExp(`^${path}$`), ...extra });

/**
 * Owner, guest and public-view surfaces reachable through the dashboard; the control service
 * decides which role may use each one. Worker, service and internal endpoints (and
 * worker-credential issuance) are not listed, so the browser cannot reach them through the proxy.
 */
export const ROUTES: Record<UpstreamService, Route[]> = {
  control: [
    r("GET", "/health", { public: true }),
    r("GET", "/session", { public: true }),
    r("POST", "/session/challenge", { public: true }),
    r("POST", "/session/verify", { public: true }),
    r("POST", "/session/logout"),
    r("GET", "/workspace"),
    r("POST", "/workspace/(stop|resume|policy)"),
    r("GET", "/activity"),
    r("GET", "/balances"),
    r("GET", "/tasks"),
    r("POST", "/agents"),
    r("PATCH", `/agents/${ID}/config`),
    r("POST", `/agents/${ID}/(run|pause|resume|revoke|archive)`),
    r("GET", `/agents/${ID}/connectors`),
    r("PUT", `/agents/${ID}/connectors/${CONNECTOR}`),
    r("DELETE", `/agents/${ID}/connectors/${CONNECTOR}`),
    r("GET", `/purchases/${ID}`),
    r("POST", `/purchases/${ID}/(decision|reconcile)`),
    r("GET", "/content"),
    r("PATCH", `/content/${ID}`),
    r("POST", `/content/${ID}/review`),
    r("GET", "/calendar"),
    r("GET", "/handoffs"),
    r("POST", `/handoffs/${ID}/decision`),
    r("GET", "/marketplace/controller"),
    r("POST", "/marketplace/controller/registration"),
    r("GET", "/marketplace/hires"),
    r("POST", "/marketplace/hires/[A-Za-z0-9._-]{1,128}/(approve|reject)"),
    r("GET", `/agents/${ID}/marketplace-allowlist`),
    r("PUT", `/agents/${ID}/marketplace-allowlist`),
    r("GET", `/agents/${ID}/connectors`),
    r("PUT", `/agents/${ID}/connectors/[a-z0-9][a-z0-9-]{2,62}`),
    r("DELETE", `/agents/${ID}/connectors/[a-z0-9][a-z0-9-]{2,62}`),
    r("GET", "/workflows/runs"),
    r("POST", "/workflows/runs"),
    r("GET", `/workflows/runs/${ID}`),
    r("POST", `/workflows/runs/${ID}/(approve|reject|advance)`),
    r("GET", `/workflows/runs/${ID}/steps/[0-7]/artifact`),
    r("GET", "/workflows/assignments"),
    r("POST", "/workflows/assignments"),
    r("POST", `/workflows/assignments/${ID}/revoke`),
    r("GET", "/external-bindings"),
    r("POST", "/external-bindings"),
    r("POST", `/external-bindings/${ID}/disable`),
    r("GET", "/ai-provider"),
    r("PUT", "/ai-provider"),
    r("DELETE", "/ai-provider"),
    r("POST", "/ai-provider/test"),
    r("POST", "/ai-provider/models"),
    r("GET", "/channels"),
    r("POST", "/channels"),
    r("DELETE", `/channels/${ID}`),
    r("POST", `/channels/${ID}/test`),
    r("POST", "/channels/telegram/chats"),
    r("PUT", `/agents/${ID}/delivery`),
    r("GET", "/swap-service"),
    r("POST", "/swap-service"),
    r("GET", `/purchases/${ID}/external-calls`),
  ],
  wallet: [
    r("POST", "/deposits/(prepare|register)"),
    r("GET", "/notes/status"),
    r("POST", "/exits/(prepare|register)"),
    r("POST", "/recovery/prepare"),
    r("POST", `/recovery/${ID}/confirm`),
  ],
  relayer: [r("GET", "/deployment", { public: true }), r("GET", "/public-state", { public: true })],
};

export function matchRoute(service: UpstreamService, method: string, path: string): Route | undefined {
  return ROUTES[service].find((x) => x.method === method && x.path.test(path));
}

function errorResponse(status: number, code: string, message: string, headers: Headers = new Headers()): Response {
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers });
}

export function readCookie(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

function csrfCookie(value: string, maxAge: number, secure: boolean): string {
  return [`${CSRF_COOKIE}=${value}`, "SameSite=Strict", "Path=/", `Max-Age=${maxAge}`, ...(secure ? ["Secure"] : [])].join("; ");
}

export interface ProxyOptions {
  config?: UpstreamConfig;
  fetchImpl?: typeof fetch;
}

/**
 * Forwards one owner request to a loopback service. Only the session cookie, the CSRF header,
 * the content type and the dashboard Origin are forwarded; Authorization and other cookies are
 * dropped. Mutating requests must come from the dashboard origin and carry the CSRF header; the
 * upstream service re-verifies both against the session.
 */
export async function proxy(req: Request, service: UpstreamService, segments: readonly string[], opts: ProxyOptions = {}): Promise<Response> {
  const config = opts.config ?? upstreamConfig();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const method = req.method.toUpperCase();
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.includes("/") || s.includes("\\"))) {
    return errorResponse(404, "NOT_FOUND", "no such endpoint");
  }
  const path = `/${segments.map(encodeURIComponent).join("/")}`;
  const route = matchRoute(service, method, path);
  if (!route) return errorResponse(404, "NOT_FOUND", "no such endpoint");

  const mutating = method !== "GET";
  if (mutating) {
    const origin = req.headers.get("origin");
    if (origin !== config.dashboardOrigin) return errorResponse(403, "FORBIDDEN", "request origin is not allowed");
    const site = req.headers.get("sec-fetch-site");
    if (site !== null && site !== "same-origin") return errorResponse(403, "FORBIDDEN", "cross-site requests are not allowed");
  }
  const csrf = req.headers.get(CSRF_HEADER);
  if (mutating && !route.public && !csrf) return errorResponse(403, "FORBIDDEN", "missing anti-CSRF token");

  const headers = new Headers({ accept: "application/json" });
  const session = readCookie(req.headers.get("cookie"), SESSION_COOKIE);
  if (session) headers.set("cookie", `${SESSION_COOKIE}=${session}`);
  if (csrf) headers.set(CSRF_HEADER, csrf);
  if (mutating) {
    headers.set("origin", config.dashboardOrigin);
    headers.set("content-type", "application/json");
  }
  const query = new URL(req.url).search;
  let upstream: Response;
  try {
    upstream = await fetchImpl(`${config.baseUrl[service]}${path}${method === "GET" ? query : ""}`, {
      method,
      headers,
      ...(mutating ? { body: (await req.text()) || "{}" } : {}),
      redirect: "manual",
      cache: "no-store",
    });
  } catch {
    return errorResponse(503, "NOT_READY", `the ${service} service is not reachable`);
  }

  const out = new Headers({ "cache-control": "no-store" });
  const type = upstream.headers.get("content-type");
  if (type) out.set("content-type", type);
  let body = await upstream.text();

  if (service === "control" && (path === "/session/verify" || path === "/session/logout")) {
    for (const c of upstream.headers.getSetCookie()) {
      if (c.startsWith(`${SESSION_COOKIE}=`)) out.append("set-cookie", c);
    }
    if (path === "/session/verify" && upstream.ok) {
      const parsed = JSON.parse(body) as { csrfToken?: unknown; expiresAt?: unknown; ownerPubkey?: unknown; role?: unknown; address?: unknown };
      if (typeof parsed.csrfToken === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(parsed.csrfToken)) {
        const maxAge = typeof parsed.expiresAt === "string" ? Math.max(0, Math.floor((Date.parse(parsed.expiresAt) - Date.now()) / 1000)) : 0;
        out.append("set-cookie", csrfCookie(parsed.csrfToken, maxAge, config.secureCookies));
      }
      body = JSON.stringify({ role: parsed.role, address: parsed.address, ownerPubkey: parsed.ownerPubkey, expiresAt: parsed.expiresAt });
    }
    if (path === "/session/logout") out.append("set-cookie", csrfCookie("", 0, config.secureCookies));
  }
  if (service === "control" && path === "/session" && upstream.ok) {
    // Only the four documented fields pass; a stale CSRF cookie is cleared once no session remains.
    let parsed: { role?: unknown; address?: unknown; expiresAt?: unknown; publicView?: unknown };
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      return errorResponse(502, "NOT_READY", "the control service returned an invalid session reply");
    }
    body = JSON.stringify({ role: parsed.role, address: parsed.address ?? null, expiresAt: parsed.expiresAt ?? null, publicView: parsed.publicView === true });
    if (parsed.role !== "owner" && parsed.role !== "guest" && readCookie(req.headers.get("cookie"), CSRF_COOKIE) !== undefined) {
      out.append("set-cookie", csrfCookie("", 0, config.secureCookies));
    }
  }
  if (upstream.status === 401) out.append("set-cookie", csrfCookie("", 0, config.secureCookies));
  return new Response(upstream.status === 204 ? null : body, { status: upstream.status, headers: out });
}
