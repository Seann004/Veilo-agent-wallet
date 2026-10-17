// Local setup: validates the toolchain and configuration and creates protected local
// directories. It never creates or replaces keys, spends funds or calls paid services.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  VeiloConfigError,
  findRepoRoot,
  loadConfig,
  loadDotEnv,
  type VeiloConfig,
} from "@veilo/contracts";
import { ensureOwnerServiceSecret } from "../services/wallet/src/secret";
import { TOOLCHAIN_IMAGE } from "./toolchain-image.mjs";

const REQUIRED_NODE_MAJOR = 22;
const MIN_NODE = [22, 14, 0] as const;
const PINNED_PNPM = "10.34.6";

const skipToolchain = process.argv.includes("--skip-toolchain");
const rootDir = findRepoRoot();
const failures: string[] = [];
const rel = (p: string) => relative(rootDir, p).split("\\").join("/") || ".";

function ok(message: string) {
  console.log(`  ok    ${message}`);
}
function warn(message: string) {
  console.log(`  warn  ${message}`);
}
function fail(message: string) {
  console.log(`  FAIL  ${message}`);
  failures.push(message);
}

function checkNode() {
  const [major = 0, minor = 0, patch = 0] = process.versions.node.split(".").map(Number);
  const tooOld =
    major < MIN_NODE[0] ||
    (major === MIN_NODE[0] && (minor < MIN_NODE[1] || (minor === MIN_NODE[1] && patch < MIN_NODE[2])));
  if (major !== REQUIRED_NODE_MAJOR || tooOld) fail(`Node ${process.versions.node}; need >=22.14.0 <23`);
  else ok(`Node ${process.versions.node}`);
}

function checkPnpm() {
  const agent = process.env.npm_config_user_agent ?? "";
  const version = /pnpm\/(\S+)/.exec(agent)?.[1];
  if (version === PINNED_PNPM) ok(`pnpm ${version}`);
  else fail(`pnpm ${version ?? "not detected"}; run through corepack with pnpm@${PINNED_PNPM}`);
}

function checkDocker() {
  if (skipToolchain) {
    warn("toolchain check skipped (--skip-toolchain); program and circuit builds need it");
    return;
  }
  const server = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
  if (server.error || server.status !== 0) {
    fail("Docker daemon not reachable; start Docker Desktop (Rust/Solana/Anchor/circom run in the toolchain image)");
    return;
  }
  ok(`Docker ${server.stdout.trim()}`);
  const image = spawnSync("docker", ["image", "inspect", TOOLCHAIN_IMAGE, "--format", "{{.Id}}"], {
    encoding: "utf8",
  });
  if (image.status !== 0) fail(`toolchain image ${TOOLCHAIN_IMAGE} missing; run pnpm toolchain:build`);
  else ok(`toolchain image ${TOOLCHAIN_IMAGE}`);
}

function ensureEnvFile() {
  const envFile = join(rootDir, ".env");
  if (existsSync(envFile)) {
    ok(".env present (not modified)");
    return;
  }
  copyFileSync(join(rootDir, ".env.example"), envFile);
  restrict(envFile, false);
  ok(".env created from .env.example; add local secrets there");
}

// Owner-only access: POSIX mode bits, or an ACL granting only the current user on Windows.
function restrict(path: string, isDir: boolean) {
  if (process.platform !== "win32") {
    chmodSync(path, isDir ? 0o700 : 0o600);
    return;
  }
  const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
  if (!user) {
    warn(`cannot determine Windows user; ${rel(path)} keeps inherited permissions`);
    return;
  }
  const grant = isDir ? `${user}:(OI)(CI)F` : `${user}:F`;
  const result = spawnSync("icacls", [path, "/inheritance:r", "/grant:r", grant], { encoding: "utf8" });
  if (result.status !== 0) warn(`icacls failed for ${rel(path)}; permissions not restricted`);
}

function ensureDir(path: string, isProtected: boolean) {
  const created = !existsSync(path);
  mkdirSync(path, { recursive: true });
  if (isProtected) restrict(path, true);
  ok(`${rel(path)}/ ${created ? "created" : "exists"}${isProtected ? " (owner-only)" : ""}`);
}

function reportSecretPath(label: string, path: string | undefined) {
  if (path === undefined) warn(`${label} not configured`);
  else if (existsSync(path)) ok(`${label} file present at ${rel(path)} (contents not read)`);
  else warn(`${label} configured but no file at ${rel(path)}; setup does not create keys`);
}

// The wallet-service root secret is the one secret setup creates: 32 random bytes, owner-only
// permissions, never printed. An existing file is never replaced.
function ensureOwnerSecret(path: string | undefined) {
  if (path === undefined) {
    warn("OWNER_SERVICE_SECRET_PATH not configured; the wallet service API stays disabled");
    return;
  }
  const { created, restricted } = ensureOwnerServiceSecret(path);
  if (created) ok(`OWNER_SERVICE_SECRET_PATH created at ${rel(path)} (${restricted ? "owner-only" : "permissions not restricted"}; back it up separately)`);
  else ok(`OWNER_SERVICE_SECRET_PATH file present at ${rel(path)} (contents not read)`);
}

function main() {
  console.log("Toolchain");
  checkNode();
  checkPnpm();
  checkDocker();

  console.log("Configuration");
  ensureEnvFile();
  loadDotEnv({ rootDir, allowProviderSecrets: true });
  let config: VeiloConfig;
  try {
    config = loadConfig(process.env, { rootDir });
    ok(`network ${config.network.caip2}, mint ${config.network.mint}`);
  } catch (error) {
    if (error instanceof VeiloConfigError) {
      fail(`${error.code}: ${error.message}`);
      return;
    }
    throw error;
  }
  if (!config.inference.realInferenceEnabled) warn("real inference disabled (no provider key or zero ceiling)");

  console.log("Directories");
  ensureDir(config.paths.dataDir, true);
  ensureDir(config.paths.secretsDir, true);
  ensureDir(join(rootDir, "artifacts", "deployment"), false);

  console.log("Secret files");
  reportSecretPath("SPONSOR_KEY_PATH", config.paths.sponsorKey);
  ensureOwnerSecret(config.paths.ownerServiceSecret);
  for (const [service, path] of Object.entries(config.paths.serviceCredentials)) {
    reportSecretPath(`${service} credential`, path);
  }
}

main();
if (failures.length > 0) {
  console.error(`\nsetup:local failed (${failures.length} problem(s)).`);
  process.exit(1);
}
console.log("\nsetup:local complete. Run pnpm check:devnet to verify chain identity, then pnpm dev.");
