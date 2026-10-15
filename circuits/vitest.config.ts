import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "circuits",
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Real Groth16 proving; each proof takes seconds.
    testTimeout: 300_000,
    hookTimeout: 900_000,
    fileParallelism: false,
  },
});
