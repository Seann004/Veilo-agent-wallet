import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  // Tests import server modules directly; outside Next's server build "server-only" would throw.
  resolve: { alias: { "server-only": fileURLToPath(new URL("./test/server-only-stub.ts", import.meta.url)) } },
  test: {
    name: "dashboard",
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["test/setup.ts"],
  },
});
