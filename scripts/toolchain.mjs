// Runs a command inside the pinned toolchain image with the repository mounted at /workspace.
//   pnpm tc -- anchor build
//   pnpm tc -- circom --version
//   pnpm toolchain:build
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLCHAIN_IMAGE } from "./toolchain-image.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let args = process.argv.slice(2);
if (args[0] === "--") args = args.slice(1);

function run(cmd, cmdArgs) {
  const result = spawnSync(cmd, cmdArgs, { stdio: "inherit" });
  if (result.error) {
    console.error(`Failed to run ${cmd}: ${result.error.message}`);
    process.exit(127);
  }
  process.exit(result.status ?? 1);
}

if (args[0] === "--build") {
  run("docker", [
    "build",
    "-f",
    resolve(repoRoot, "docker", "toolchain.Dockerfile"),
    "-t",
    TOOLCHAIN_IMAGE,
    resolve(repoRoot, "docker"),
  ]);
}

if (args.length === 0) {
  console.error("Usage: pnpm tc -- <command> [args...]   (e.g. pnpm tc -- anchor build)");
  process.exit(2);
}

// Preserve the caller's position inside the repository; outside it, fall back to the root.
const rel = relative(repoRoot, process.env.INIT_CWD ?? process.cwd());
const workdir = rel.startsWith("..") || isAbsolute(rel) ? "/workspace" : `/workspace/${rel.split(sep).join("/")}`;

run("docker", [
  "run",
  "--rm",
  ...(process.stdin.isTTY ? ["-it"] : ["-i"]),
  "-v",
  `${repoRoot}:/workspace`,
  // Cargo caches persist across runs without touching the host.
  "-v",
  "veilo-cargo-registry:/root/.cargo/registry",
  "-v",
  "veilo-cargo-git:/root/.cargo/git",
  "-w",
  workdir,
  TOOLCHAIN_IMAGE,
  ...args,
]);
