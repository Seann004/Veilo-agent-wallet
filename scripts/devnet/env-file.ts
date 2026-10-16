import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "./lib";

export interface EnvFillResult {
  set: string[];
  unchanged: string[];
  conflicts: string[];
}

/**
 * Fills public (non-secret) variables in the local .env: empty or missing keys are set, an
 * identical value is left alone, and a different existing value is reported, never replaced.
 * Only the named keys are read or written; no other value is printed.
 */
export function fillEnv(vars: Record<string, string>, path = process.env.VEILO_ENV_FILE ?? join(REPO, ".env")): EnvFillResult {
  const out: EnvFillResult = { set: [], unchanged: [], conflicts: [] };
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  for (const [key, value] of Object.entries(vars)) {
    const i = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (i < 0) {
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.splice(lines.length - 1, 0, `${key}=${value}`);
      else lines.push(`${key}=${value}`);
      out.set.push(key);
      continue;
    }
    const current = lines[i]!.slice(key.length + 1).trim();
    if (current === value) out.unchanged.push(key);
    else if (current === "") {
      lines[i] = `${key}=${value}`;
      out.set.push(key);
    } else out.conflicts.push(key);
  }
  if (out.set.length > 0) writeFileSync(path, lines.join("\n"));
  return out;
}
