import { DEVNET_GENESIS_HASH, findRepoRoot, isMainnetIdentifier, loadDotEnv } from "@veilo/contracts";
import { createRpcChain } from "./chain";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { createDb } from "./db";

const SWEEP_MS = 30_000;

async function main(): Promise<void> {
  loadDotEnv({ rootDir: findRepoRoot(), allowMarketplaceSecrets: true });
  const config = loadConfig();
  // Fail closed: the marketplace only records devnet receipts for the configured mint.
  if (config.genesisHash !== DEVNET_GENESIS_HASH || isMainnetIdentifier(config.network)) throw new Error("marketplace runs on Solana devnet only");
  const chain = createRpcChain(config.rpcUrl);
  const observed = await chain.genesisHash();
  if (observed !== config.genesisHash) throw new Error(`RPC genesis ${observed} is not the expected devnet genesis`);
  const db = createDb(config);
  const app = createApp({ db, chain, config, now: () => new Date() });
  const server = app.listen(config.port, config.bindHost, () => {
    console.log(`[marketplace] listening on http://${config.bindHost}:${config.port} (${config.network})`);
  });
  const sweep = setInterval(() => {
    db.rpc<number>("mk_expire_sweep", {}).catch(() => console.warn("[marketplace] expiry sweep failed; will retry"));
  }, SWEEP_MS);
  const stop = () => {
    clearInterval(sweep);
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error: unknown) => {
  console.error(`[marketplace] ${error instanceof Error ? error.message : "startup failed"}`);
  process.exit(1);
});
