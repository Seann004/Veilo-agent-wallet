import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Writes a new secret file readable only by its owner. Never overwrites: a second writer racing
 * for the same path fails with EEXIST, and the caller re-reads the file that won.
 */
export function writeSecretFileOnce(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, contents, { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}

/** Reads a secret file, refusing one that group or others can read. */
export function readSecretFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`secret file permissions are too open; expected 0600`);
  const v = readFileSync(path, "utf8").trim();
  return v === "" ? undefined : v;
}
