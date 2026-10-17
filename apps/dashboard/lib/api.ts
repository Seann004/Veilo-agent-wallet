export type Service = "control" | "wallet" | "relayer";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function csrfToken(cookie: string = typeof document === "undefined" ? "" : document.cookie): string | undefined {
  for (const part of cookie.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === "veilo_csrf") {
      const v = part.slice(i + 1).trim();
      return v === "" ? undefined : v;
    }
  }
  return undefined;
}

/** Calls an owner endpoint through the same-origin dashboard proxy. */
export async function api<T = unknown>(service: Service, path: string, init: { method?: "GET" | "POST" | "PATCH" | "PUT"; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    const csrf = csrfToken();
    if (csrf) headers["x-csrf-token"] = csrf;
  }
  let res: Response;
  try {
    res = await fetch(`/api/${service}${path}`, {
      method,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      ...(method !== "GET" ? { body: JSON.stringify(init.body ?? {}) } : {}),
    });
  } catch {
    throw new ApiError(0, "NOT_READY", "the dashboard server is not reachable");
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const e = (body as { error?: { code?: string; message?: string } } | null)?.error;
    if (!e && (res.status === 404 || res.status >= 502)) {
      // The service answered without its JSON API: it is running without the configuration this endpoint needs.
      throw new ApiError(res.status, "NOT_READY", `the ${service} service does not serve this endpoint yet (not configured or not deployed)`);
    }
    throw new ApiError(res.status, e?.code ?? "INTERNAL_ERROR", e?.message ?? `request failed with status ${res.status}`);
  }
  return body as T;
}

/** Service health: a 503 still carries the chain-identity report, so its body is returned too. */
export async function health<T>(service: Service): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/${service}/health`, { cache: "no-store" });
  } catch {
    throw new ApiError(0, "NOT_READY", "the dashboard server is not reachable");
  }
  const body = (await res.json().catch(() => null)) as (T & { chain?: unknown; error?: { code?: string; message?: string } }) | null;
  if (body && body.chain !== undefined) return body;
  throw new ApiError(res.status, body?.error?.code ?? "NOT_READY", body?.error?.message ?? `the ${service} service is not reachable`);
}
