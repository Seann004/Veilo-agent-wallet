import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";

/** Walks up from `start` to the directory containing pnpm-workspace.yaml. */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`No pnpm-workspace.yaml found above ${start}`);
    dir = parent;
  }
}

export const PROVIDER_SECRET_VARS = ["OPENROUTER_API_KEY"] as const;

export interface LoadDotEnvOptions {
  rootDir?: string;
  /** Only the gateway process may receive the provider API key. */
  allowProviderSecrets?: boolean;
  /** Additional variables this process must not receive. */
  omit?: readonly string[];
}

/**
 * Loads `<root>/.env` (or VEILO_ENV_FILE) into process.env. Existing environment variables
 * win. Provider secrets are dropped unless explicitly allowed, and also removed from the
 * inherited environment so child processes cannot see them. Values are never echoed.
 */
export function loadDotEnv(options: LoadDotEnvOptions = {}): boolean {
  const omit = new Set<string>(options.omit ?? []);
  if (!options.allowProviderSecrets) for (const name of PROVIDER_SECRET_VARS) omit.add(name);
  for (const name of omit) delete process.env[name];

  const rootDir = options.rootDir ?? findRepoRoot();
  const file = process.env.VEILO_ENV_FILE ?? join(rootDir, ".env");
  if (!existsSync(file)) return false;
  const parsed = parseEnv(readFileSync(file, "utf8"));
  for (const [name, value] of Object.entries(parsed)) {
    if (omit.has(name) || value === undefined) continue;
    if (process.env[name] === undefined) process.env[name] = value;
  }
  return true;
}
