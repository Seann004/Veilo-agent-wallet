// VEILO_TOOLCHAIN=native runs toolchain commands on the host instead of in the Docker image.
// The pins are read from docker/toolchain.Dockerfile, so both modes share one set of versions;
// a missing tool or a version mismatch stops the command before it runs.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function toolchainMode() {
  const mode = (process.env.VEILO_TOOLCHAIN ?? "docker").trim() || "docker";
  if (mode !== "docker" && mode !== "native") throw new Error(`VEILO_TOOLCHAIN must be "docker" or "native", got "${mode}"`);
  return mode;
}

export function isNativeToolchain() {
  return toolchainMode() === "native";
}

/** Repository root as the toolchain sees it: the bind mount in Docker, the checkout natively. */
export function toolchainWorkspace() {
  return isNativeToolchain() ? REPO_ROOT : "/workspace";
}

export function toolchainPins() {
  const dockerfile = readFileSync(join(REPO_ROOT, "docker", "toolchain.Dockerfile"), "utf8");
  const arg = (name) => {
    const m = new RegExp(`^ARG ${name}=(\\S+)$`, "m").exec(dockerfile);
    if (!m) throw new Error(`docker/toolchain.Dockerfile has no ARG ${name}`);
    return m[1];
  };
  return {
    rust: arg("RUST_VERSION"),
    agave: arg("AGAVE_VERSION").replace(/^v/, ""),
    anchor: arg("ANCHOR_VERSION"),
    circom: arg("CIRCOM_TAG").replace(/^v/, ""),
    platformTools: arg("PLATFORM_TOOLS_VERSION"),
  };
}

function versionOf(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: REPO_ROOT, encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  return `${r.stdout}${r.stderr}`.trim().split("\n")[0].trim();
}

/** Returns the problems found; an empty list means every pinned tool matches. */
export function nativeToolchainProblems() {
  const pins = toolchainPins();
  const checks = [
    ["rustc", ["--version"], new RegExp(`^rustc ${pins.rust.replace(/\./g, "\\.")} `), `rustc ${pins.rust}`],
    ["solana", ["--version"], new RegExp(`^solana-cli ${pins.agave.replace(/\./g, "\\.")} `), `solana-cli ${pins.agave}`],
    ["anchor", ["--version"], new RegExp(`^anchor-cli ${pins.anchor.replace(/\./g, "\\.")}$`), `anchor-cli ${pins.anchor}`],
    ["circom", ["--version"], new RegExp(`^circom compiler ${pins.circom.replace(/\./g, "\\.")}$`), `circom compiler ${pins.circom}`],
  ];
  const problems = [];
  for (const [cmd, args, want, label] of checks) {
    const got = versionOf(cmd, args);
    if (got === null) problems.push(`${cmd} not found on PATH (need ${label})`);
    else if (!want.test(got)) problems.push(`${cmd} reports "${got}", need ${label}`);
  }
  const tools = join(homedir(), ".cache", "solana", pins.platformTools, "platform-tools");
  if (!existsSync(tools)) problems.push(`SBF platform-tools ${pins.platformTools} missing (cargo-build-sbf --install-only --tools-version ${pins.platformTools})`);
  return problems;
}

/** Exits the process if any pinned tool is missing or at another version. */
export function assertNativeToolchain() {
  const problems = nativeToolchainProblems();
  if (problems.length === 0) return;
  console.error("VEILO_TOOLCHAIN=native: host toolchain does not match docker/toolchain.Dockerfile:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

/** Environment for host runs: build output stays under the gitignored target/ directory. */
export function nativeToolchainEnv() {
  return {
    ...process.env,
    VEILO_WORKSPACE: REPO_ROOT,
    VEILO_CACHE_DIR: join(REPO_ROOT, "target", "native-cache"),
  };
}
