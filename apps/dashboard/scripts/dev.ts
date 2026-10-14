import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { findRepoRoot, loadConfig, loadDotEnv } from "@veilo/contracts";

const rootDir = findRepoRoot();
loadDotEnv();
const config = loadConfig(process.env, { rootDir });
const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");

const child = spawn(
  process.execPath,
  [nextBin, "dev", "--port", String(config.ports.dashboard), "--hostname", config.bindHost],
  { stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 1));
