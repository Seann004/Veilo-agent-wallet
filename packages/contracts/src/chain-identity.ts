import type { VeiloConfig } from "./config";
import { VeiloConfigError } from "./errors";
import { isLoopbackUrl } from "./config";
import { DEMO_TOKEN_DECIMALS, SPL_TOKEN_PROGRAM_ID, isMainnetIdentifier } from "./network";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ChainIdentityResult {
  genesisHash: string;
  caip2: string;
  mint: string;
  mintOwner: string;
  mintDecimals: number;
  checkedAt: string;
}

// SPL Token Mint layout: 36-byte COption<Pubkey> authority, u64 supply, u8 decimals, bool initialized, ...
const MINT_ACCOUNT_SIZE = 82;
const MINT_DECIMALS_OFFSET = 44;
const MINT_INITIALIZED_OFFSET = 45;

let rpcId = 0;

async function rpcCall<T>(fetchImpl: FetchLike, url: string, method: string, params: unknown[]): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new VeiloConfigError("RPC_UNAVAILABLE", `RPC ${method} request failed: ${(error as Error).message}`);
  }
  if (!response.ok) {
    throw new VeiloConfigError("RPC_UNAVAILABLE", `RPC ${method} returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) {
    throw new VeiloConfigError("RPC_UNAVAILABLE", `RPC ${method} error ${body.error.code}: ${body.error.message}`);
  }
  if (!("result" in body)) {
    throw new VeiloConfigError("RPC_UNAVAILABLE", `RPC ${method} returned no result`);
  }
  return body.result as T;
}

interface AccountInfoResult {
  value: { owner: string; data: [string, string]; executable: boolean; lamports: number } | null;
}

/**
 * Fails closed unless the RPC endpoint is Solana devnet and the configured mint is a
 * six-decimal, initialized mint owned by the original SPL Token program. Under the
 * local-test-validator profile the endpoint must instead be a loopback validator whose genesis
 * is neither devnet nor mainnet, so that profile never acts on a public cluster.
 * Read-only: issues getGenesisHash and getAccountInfo at finalized commitment.
 */
export async function verifyChainIdentity(
  config: VeiloConfig,
  fetchImpl: FetchLike = fetch,
): Promise<ChainIdentityResult> {
  const { rpcUrl, genesisHash: expectedGenesis, caip2, mint } = config.network;

  const genesisHash = await rpcCall<string>(fetchImpl, rpcUrl, "getGenesisHash", []);
  if (typeof genesisHash !== "string") {
    throw new VeiloConfigError("WRONG_NETWORK", "RPC returned a malformed genesis hash");
  }
  if (isMainnetIdentifier(genesisHash)) {
    throw new VeiloConfigError("WRONG_NETWORK", "RPC endpoint is Solana mainnet; refusing to continue");
  }
  if (config.network.profile === "local-test-validator") {
    if (!isLoopbackUrl(rpcUrl)) throw new VeiloConfigError("WRONG_NETWORK", "local-test-validator profile requires a loopback RPC");
    if (genesisHash === expectedGenesis) {
      throw new VeiloConfigError("WRONG_NETWORK", "local-test-validator profile refuses the devnet cluster");
    }
  } else {
    if (genesisHash !== expectedGenesis) {
      throw new VeiloConfigError(
        "WRONG_NETWORK",
        `RPC genesis hash ${genesisHash} does not match expected devnet genesis ${expectedGenesis}`,
      );
    }
    if (`solana:${genesisHash.slice(0, 32)}` !== caip2) {
      throw new VeiloConfigError("WRONG_NETWORK", `CAIP-2 network ${caip2} does not match RPC genesis hash`);
    }
  }

  const account = await rpcCall<AccountInfoResult>(fetchImpl, rpcUrl, "getAccountInfo", [
    mint,
    { encoding: "base64", commitment: "finalized" },
  ]);
  if (!account || account.value === null) {
    throw new VeiloConfigError("WRONG_MINT", `Mint ${mint} does not exist on this cluster`);
  }
  if (account.value.owner !== SPL_TOKEN_PROGRAM_ID) {
    throw new VeiloConfigError(
      "WRONG_MINT",
      `Mint ${mint} is owned by ${account.value.owner}, expected SPL Token program ${SPL_TOKEN_PROGRAM_ID}`,
    );
  }
  const [encoded, encoding] = account.value.data;
  if (encoding !== "base64") {
    throw new VeiloConfigError("WRONG_MINT", `Unexpected account encoding ${encoding}`);
  }
  const data = Buffer.from(encoded, "base64");
  if (data.length !== MINT_ACCOUNT_SIZE) {
    throw new VeiloConfigError("WRONG_MINT", `Account ${mint} is not an SPL mint (size ${data.length})`);
  }
  if (data[MINT_INITIALIZED_OFFSET] !== 1) {
    throw new VeiloConfigError("WRONG_MINT", `Mint ${mint} is not initialized`);
  }
  const decimals = data[MINT_DECIMALS_OFFSET];
  if (decimals !== DEMO_TOKEN_DECIMALS || decimals !== config.network.mintDecimals) {
    throw new VeiloConfigError(
      "WRONG_MINT",
      `Mint ${mint} has ${String(decimals)} decimals, expected ${config.network.mintDecimals}`,
    );
  }

  return {
    genesisHash,
    caip2,
    mint,
    mintOwner: account.value.owner,
    mintDecimals: decimals,
    checkedAt: new Date().toISOString(),
  };
}
