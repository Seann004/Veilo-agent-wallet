import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["apps/*", "services/*", "packages/*"],
  },
});
