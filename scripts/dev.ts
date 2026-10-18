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
// An optional second seller host for the carousel creator, started when its settings are in .env.
const carousel = carouselSellerHost();
const marketplace = [
  ...(marketplaceOn ? [{ name: "marketplace", command: tsx("src/index.ts"), cwd: join(rootDir, "services", "marketplace") }] : []),
  ...(sellerHostOn
    ? [{ name: "seller-host", command: tsx("src/index.ts"), cwd: join(rootDir, "services", "gateway"), env: { GATEWAY_ROLE: "seller-host" } }]
    : []),
  ...(marketplaceOn && carousel ? [{ name: "carousel-host", command: tsx("src/index.ts"), cwd: join(rootDir, "services", "gateway"), env: carousel }] : []),
];

function carouselSellerHost(): Record<string, string> | null {
  const e = (name: string) => process.env[name]?.trim() || undefined;
  const origin = e("CAROUSEL_SELLER_ORIGIN");
  const identity = e("CAROUSEL_SELLER_IDENTITY");
  const recipients = e("CAROUSEL_SELLER_RECIPIENTS");
  const token = e("CAROUSEL_SELLER_TOKEN_PATH");
  if (!origin || !identity || !recipients || !token) return null;
  const port = new URL(origin).port;
  if (!port) return null;
  return {
    GATEWAY_ROLE: "seller-host",
    SELLER_HOST_PORT: port,
    SELLER_HOST_PUBLIC_ORIGIN: origin,
    SELLER_HOST_IDENTITY: identity,
    SELLER_HOST_RECIPIENTS: recipients,
    SELLER_HOST_DATABASE_PATH: e("CAROUSEL_SELLER_DATABASE_PATH") ?? "data/seller-host-carousel.sqlite",
    MARKETPLACE_SELLER_HOST_TOKEN_PATH: join(rootDir, token),
  };
}

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
