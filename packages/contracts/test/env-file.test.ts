import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDotEnv } from "../src/index";

const touched = ["VEILO_ENV_FILE", "OPENROUTER_API_KEY", "VEILO_TEST_PLAIN"];

afterEach(() => {
  for (const name of touched) delete process.env[name];
});

function writeEnv(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "veilo-env-"));
  const file = join(dir, ".env");
  writeFileSync(file, contents);
  return file;
}

describe("loadDotEnv", () => {
  it("withholds the provider key from processes that are not allowed it", () => {
    process.env.VEILO_ENV_FILE = writeEnv("OPENROUTER_API_KEY=sk-test\nVEILO_TEST_PLAIN=1\n");
    process.env.OPENROUTER_API_KEY = "inherited";
    loadDotEnv({ rootDir: tmpdir() });
    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(process.env.VEILO_TEST_PLAIN).toBe("1");
  });

  it("loads the provider key when explicitly allowed", () => {
    process.env.VEILO_ENV_FILE = writeEnv("OPENROUTER_API_KEY=sk-test\n");
    loadDotEnv({ rootDir: tmpdir(), allowProviderSecrets: true });
    expect(process.env.OPENROUTER_API_KEY).toBe("sk-test");
  });

  it("does not override variables already set", () => {
    process.env.VEILO_ENV_FILE = writeEnv("VEILO_TEST_PLAIN=from-file\n");
    process.env.VEILO_TEST_PLAIN = "from-env";
    loadDotEnv({ rootDir: tmpdir() });
    expect(process.env.VEILO_TEST_PLAIN).toBe("from-env");
  });
});
