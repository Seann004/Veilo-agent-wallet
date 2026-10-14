import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "control",
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
