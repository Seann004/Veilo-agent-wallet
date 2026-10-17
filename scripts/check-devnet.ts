// Read-only devnet identity check: getGenesisHash and the mint account. No signing.
import {
  VeiloConfigError,
  findRepoRoot,
  loadConfig,
  loadDotEnv,
  redactUrl,
  verifyChainIdentity,
} from "@veilo/contracts";

async function main() {
  const rootDir = findRepoRoot();
  loadDotEnv({ rootDir });
  const config = loadConfig(process.env, { rootDir });
  console.log(`RPC ${redactUrl(config.network.rpcUrl)}`);
  const identity = await verifyChainIdentity(config);
  console.log(JSON.stringify({ result: "devnet identity verified", ...identity }, null, 2));
}

main().catch((error: unknown) => {
  if (error instanceof VeiloConfigError) {
    console.error(`Devnet check failed (${error.code}): ${error.message}`);
  } else {
    console.error(`Devnet check failed: ${(error as Error).message}`);
  }
  process.exit(1);
});
