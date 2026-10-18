const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Names of the hosted upstream settings, checked at build time and per request. */
export const HOSTED_ENV = ["VEILO_DASHBOARD_ORIGIN", "VEILO_CONTROL_URL", "VEILO_WALLET_URL", "VEILO_RELAYER_URL"] as const;

/**
 * An explicit upstream: https, or http only to loopback; no credentials, query or fragment.
 * The base is rebuilt from origin and path, so a stray "?" or "#" cannot end up in it.
 */
export function upstreamUrl(name: string, raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${name} must be a URL`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) throw new Error(`${name} must use https (http only for localhost)`);
  if (u.username || u.password || u.search || u.hash || /[?#]/.test(raw)) throw new Error(`${name} must not carry credentials, a query or a fragment`);
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** Fails a hosted build early when an upstream setting is missing or unsafe. */
export function assertHostedConfig(env: NodeJS.ProcessEnv): void {
  const missing = HOSTED_ENV.filter((k) => !env[k]?.trim());
  if (missing.length > 0) throw new Error(`hosted dashboard is missing ${missing.join(", ")}`);
  for (const k of HOSTED_ENV) upstreamUrl(k, env[k]!.trim());
}
