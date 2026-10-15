/** Loopback upstreams behind the dashboard proxy. The browser never contacts them directly. */
export const UPSTREAM_SERVICES = ["control", "wallet", "relayer"] as const;
export type UpstreamService = (typeof UPSTREAM_SERVICES)[number];

const DEFAULT_PORTS: Record<UpstreamService | "dashboard", number> = {
  dashboard: 3000,
  control: 4101,
  wallet: 4103,
  relayer: 4105,
};

const PORT_ENV: Record<UpstreamService | "dashboard", string> = {
  dashboard: "DASHBOARD_PORT",
  control: "CONTROL_PORT",
  wallet: "WALLET_PORT",
  relayer: "RELAYER_PORT",
};

function port(env: NodeJS.ProcessEnv, name: UpstreamService | "dashboard"): number {
  const raw = env[PORT_ENV[name]]?.trim();
  if (!raw) return DEFAULT_PORTS[name];
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65_535) throw new Error(`${PORT_ENV[name]} must be a TCP port`);
  return n;
}

export interface UpstreamConfig {
  /** Exact browser origin of this dashboard; mutating requests from any other Origin are refused. */
  dashboardOrigin: string;
  secureCookies: boolean;
  baseUrl: Record<UpstreamService, string>;
}

export function upstreamConfig(env: NodeJS.ProcessEnv = process.env): UpstreamConfig {
  const host = env.VEILO_BIND_HOST?.trim() || "127.0.0.1";
  const loopbackHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  const origin = new URL(env.VEILO_DASHBOARD_ORIGIN?.trim() || `http://localhost:${port(env, "dashboard")}`).origin;
  const base = (s: UpstreamService) => `http://${loopbackHost}:${port(env, s)}`;
  return {
    dashboardOrigin: origin,
    secureCookies: origin.startsWith("https:"),
    baseUrl: { control: base("control"), wallet: base("wallet"), relayer: base("relayer") },
  };
}
