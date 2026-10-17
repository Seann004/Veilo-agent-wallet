import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "marketplace",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
