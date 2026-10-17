/** Endpoints this host may contact, from its own configuration; bearer tokens stay in this process. */
export function mcpConfigFromEnv(env: NodeJS.ProcessEnv): { endpoints: ReadonlySet<string>; bearerFor: (connectorId: string) => string | undefined } {
  const endpoints = new Set((env.SELLER_HOST_MCP_ENDPOINTS ?? "").split(",").map((x) => x.trim()).filter((x) => x !== ""));
  return {
    endpoints,
    bearerFor: (id) => env[`MCP_BEARER_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`]?.trim() || undefined,
  };
}
