import { createRequire } from "node:module";
import { join } from "node:path";
import concurrently from "concurrently";
import { findRepoRoot } from "@veilo/contracts";

// Each process loads .env itself so provider secrets reach only the gateway. Processes are
// started directly rather than via nested pnpm runs, which race on pnpm's workspace state.
const rootDir = findRepoRoot();
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const tsx = (entry: string) => `"${process.execPath}" "${tsxCli}" ${entry}`;
const services = ["control", "runner", "wallet", "gateway", "relayer"] as const;

const { result } = concurrently(
  [
    { name: "dashboard", command: tsx("scripts/dev.ts"), cwd: join(rootDir, "apps", "dashboard") },
    ...services.map((name) => ({ name, command: tsx("src/index.ts"), cwd: join(rootDir, "services", name) })),
  ],
  // Any exit (for example a failed chain identity check) stops the whole stack.
  { prefix: "name", killOthersOn: ["failure", "success"], restartTries: 0 },
);

result.then(
  () => process.exit(0),
  () => process.exit(1),
);
