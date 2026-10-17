import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "runner",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
