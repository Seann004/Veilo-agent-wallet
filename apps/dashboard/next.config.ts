import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { assertHostedConfig } from "./lib/server/upstream-url";

// On Vercel the services live elsewhere; refuse to build without valid addresses for them.
if (process.env.VERCEL) assertHostedConfig(process.env);

const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  agentRules: false,
  transpilePackages: ["@veilo/contracts"],
  // Workspace packages live above this app; trace from the repo root so hosted builds include them.
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  // Old page addresses, kept working after pages were merged.
  async redirects() {
    const moved: Array<[string, string]> = [
      ["/activity", "/wallet"],
      ["/recovery", "/wallet"],
      ["/privacy", "/settings"],
      ["/content", "/outputs"],
      ["/market", "/marketplace"],
      ["/marketplace/specialists", "/marketplace"],
      ["/marketplace/templates", "/marketplace"],
    ];
    return moved.map(([source, destination]) => ({ source, destination, permanent: false }));
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
