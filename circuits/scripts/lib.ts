import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CIRCUITS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = resolve(CIRCUITS_DIR, "..");
export const BUILD_DIR = resolve(CIRCUITS_DIR, "build");
export const ARTIFACTS_DIR = resolve(REPO_ROOT, "artifacts/circuits");
export const MANIFEST_PATH = resolve(ARTIFACTS_DIR, "manifest.json");
export const VECTORS_PATH = resolve(REPO_ROOT, "artifacts/vectors/v1.json");
export const GROTH16_VECTORS_PATH = resolve(REPO_ROOT, "artifacts/vectors/groth16-v1.json");
export const RUST_VK_DIR = resolve(REPO_ROOT, "programs/veilo-crypto/src/vk");

export const MAIN_CIRCUITS = ["spend", "insert", "exit"] as const;
export type MainCircuit = (typeof MAIN_CIRCUITS)[number];
export const HARNESS_CIRCUITS = ["hashes", "merkle16"] as const;
export type HarnessCircuit = (typeof HARNESS_CIRCUITS)[number];

export const PTAU_POWER = 15;
export const PTAU_PATH = resolve(BUILD_DIR, "ptau", `pot${PTAU_POWER}_veilo_dev_final.ptau`);
export const COMPILER_FLAGS = ["--r1cs", "--wasm", "--sym", "--O2", "--prime", "bn128"];

export function sourcePath(name: MainCircuit | HarnessCircuit): string {
  return (MAIN_CIRCUITS as readonly string[]).includes(name)
    ? resolve(CIRCUITS_DIR, "src", `${name}.circom`)
    : resolve(CIRCUITS_DIR, "test/harness", `${name}.circom`);
}

export function outDir(name: string): string {
  return resolve(BUILD_DIR, name);
}

export function artifactPaths(name: string) {
  const dir = outDir(name);
  return {
    r1cs: resolve(dir, `${name}.r1cs`),
    sym: resolve(dir, `${name}.sym`),
    wasm: resolve(dir, `${name}_js`, `${name}.wasm`),
    zkey: resolve(BUILD_DIR, "zkey", `${name}_final.zkey`),
    vkeyJson: resolve(ARTIFACTS_DIR, `${name}.vkey.json`),
    vkRust: resolve(RUST_VK_DIR, `${name}.rs`),
  };
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Directory containing the pinned circomlib package (passed to circom with -l). */
export function circomlibParent(): string {
  const require = createRequire(import.meta.url);
  return dirname(realpathSync(dirname(require.resolve("circomlib/package.json"))));
}

export function circomlibVersion(): string {
  const pkg = JSON.parse(readFileSync(resolve(circomlibParent(), "circomlib/package.json"), "utf8")) as { version: string };
  return pkg.version;
}

export function toRepoPosix(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join(posix.sep);
}

/** Every file reachable through `include`, keyed by a stable logical path, with its sha256. */
export function sourceFiles(main: string): Record<string, string> {
  const lib = circomlibParent();
  const files: Record<string, string> = {};
  const visit = (file: string): void => {
    const libRel = relative(lib, file);
    const key = libRel.startsWith("..") ? toRepoPosix(file) : `${libRel.split(sep).join("/")}@${circomlibVersion()}`;
    if (key in files) return;
    files[key] = sha256File(file);
    for (const m of readFileSync(file, "utf8").matchAll(/^\s*include\s+"([^"]+)"\s*;/gm)) {
      const spec = m[1]!;
      const local = resolve(dirname(file), spec);
      const target = existsSync(local) ? local : resolve(lib, spec);
      if (!existsSync(target)) throw new Error(`unresolved include ${spec} in ${file}`);
      visit(target);
    }
  };
  visit(main);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** sha256 over `sha256sum`-style lines of every included source, sorted by path. */
export function sourceTreeHash(files: Record<string, string>): string {
  return sha256Text(Object.entries(files).map(([path, sha]) => `${sha}  ${path}\n`).join(""));
}

/** Runs a shell command inside the pinned toolchain image (repo at /workspace). */
export function toolchain(command: string): string {
  const res = spawnSync("node", [resolve(REPO_ROOT, "scripts/toolchain.mjs"), "--", "sh", "-c", command], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (res.status !== 0) throw new Error(`toolchain command failed (${res.status}): ${command}`);
  return res.stdout;
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
