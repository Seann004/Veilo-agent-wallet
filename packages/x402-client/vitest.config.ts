import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "x402-client",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
