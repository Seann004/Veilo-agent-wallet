import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 1_200_000,
    hookTimeout: 3_600_000,
    fileParallelism: false,
    pool: "forks",
    sequence: { concurrent: false },
  },
});
