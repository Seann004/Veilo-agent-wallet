import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  agentRules: false,
  transpilePackages: ["@veilo/contracts"],
};

export default nextConfig;
