import { createRequire } from "node:module";
import { join } from "node:path";
import concurrently from "concurrently";
import { findRepoRoot, loadDotEnv } from "@veilo/contracts";

// Each process loads .env itself so provider secrets reach only the gateway. Processes are
// started directly rather than via nested pnpm runs, which race on pnpm's workspace state.
const rootDir = findRepoRoot();
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const tsx = (entry: string) => `"${process.execPath}" "${tsxCli}" ${entry}`;
const services = ["control", "runner", "wallet", "gateway", "relayer"] as const;

// Only the variable names are inspected here; each child loads .env itself.
loadDotEnv({ rootDir });
const marketplaceOn = Boolean(process.env.SUPABASE_URL?.trim());
const sellerHostOn = marketplaceOn && Boolean(process.env.MARKETPLACE_SELLER_HOST_TOKEN_PATH?.trim());
const marketplace = [
  ...(marketplaceOn ? [{ name: "marketplace", command: tsx("src/index.ts"), cwd: join(rootDir, "services", "marketplace") }] : []),
  ...(sellerHostOn
    ? [{ name: "seller-host", command: tsx("src/index.ts"), cwd: join(rootDir, "services", "gateway"), env: { GATEWAY_ROLE: "seller-host" } }]
    : []),
];

const { result } = concurrently(
  [
    { name: "dashboard", command: tsx("scripts/dev.ts"), cwd: join(rootDir, "apps", "dashboard") },
    ...services.map((name) => ({ name, command: tsx("src/index.ts"), cwd: join(rootDir, "services", name) })),
    ...marketplace,
  ],
  // Any exit (for example a failed chain identity check) stops the whole stack.
  { prefix: "name", killOthersOn: ["failure", "success"], restartTries: 0 },
);

result.then(
  () => process.exit(0),
  () => process.exit(1),
);
