import { describe, expect, it } from "vitest";
import {
  DEMO_TOKEN_MINT,
  DEVNET_GENESIS_HASH,
  MAINNET_CAIP2,
  MAINNET_CAIP2_FULL,
  MAINNET_GENESIS_HASH,
  SPL_TOKEN_PROGRAM_ID,
  VeiloConfigError,
  describeConfig,
  loadConfig,
  verifyChainIdentity,
  type FetchLike,
} from "../src/index";

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const baseEnv = {
  DEVNET_RPC_URL: "https://rpc.test.invalid",
  EXPECTED_DEVNET_GENESIS_HASH: DEVNET_GENESIS_HASH,
  DEMO_TOKEN_MINT,
  FACILITATOR_URL: "https://facilitator.payai.network",
};

function mintData({ decimals = 6, initialized = 1, size = 82 } = {}): string {
  const data = Buffer.alloc(size);
  if (size > 45) {
    data[44] = decimals;
    data[45] = initialized;
  }
  return data.toString("base64");
}

interface RpcFixture {
  genesis?: string;
  owner?: string;
  data?: string;
  missingMint?: boolean;
}

function mockRpc(fixture: RpcFixture = {}): { fetch: FetchLike; calls: Array<{ method: string; params: unknown[] }> } {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const req = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] };
    calls.push({ method: req.method, params: req.params });
    let result: unknown;
    if (req.method === "getGenesisHash") result = fixture.genesis ?? DEVNET_GENESIS_HASH;
    else if (req.method === "getAccountInfo")
      result = {
        context: { slot: 1 },
        value: fixture.missingMint
          ? null
          : {
              owner: fixture.owner ?? SPL_TOKEN_PROGRAM_ID,
              data: [fixture.data ?? mintData(), "base64"],
              executable: false,
              lamports: 1461600,
            },
      };
    else throw new Error(`unexpected method ${req.method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }), { status: 200 });
  };
  return { fetch: fetchImpl, calls };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(VeiloConfigError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe("NET-01 static configuration guard", () => {
  it("accepts the pinned devnet configuration", () => {
    const config = loadConfig(baseEnv);
    expect(config.network.genesisHash).toBe(DEVNET_GENESIS_HASH);
    expect(config.network.caip2).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    expect(config.network.mintDecimals).toBe(6);
  });

  it("rejects the mainnet genesis hash", () => {
    expect(() => loadConfig({ ...baseEnv, EXPECTED_DEVNET_GENESIS_HASH: MAINNET_GENESIS_HASH })).toThrow(
      expect.objectContaining({ code: "WRONG_NETWORK" }),
    );
  });

  it.each([MAINNET_CAIP2, MAINNET_CAIP2_FULL])("rejects mainnet CAIP-2 %s", (caip2) => {
    expect(() => loadConfig({ ...baseEnv, SOLANA_CAIP2_NETWORK: caip2 })).toThrow(
      expect.objectContaining({ code: "WRONG_NETWORK" }),
    );
  });

  it("rejects any other network identifier", () => {
    expect(() => loadConfig({ ...baseEnv, SOLANA_CAIP2_NETWORK: "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z" })).toThrow(
      VeiloConfigError,
    );
  });

  it("rejects a mint other than the pinned test mint", () => {
    expect(() => loadConfig({ ...baseEnv, DEMO_TOKEN_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" })).toThrow(
      expect.objectContaining({ code: "WRONG_MINT" }),
    );
  });

  it("defaults the real-dollar ceiling to zero, disabling real inference", () => {
    const config = loadConfig({ ...baseEnv, OPENROUTER_API_KEY: "sk-test-not-real" });
    expect(config.inference.operatorMaxRealUsdMicro).toBe(0n);
    expect(config.inference.realInferenceEnabled).toBe(false);
  });

  it("requires both a key and a positive ceiling to enable real inference", () => {
    expect(loadConfig({ ...baseEnv, OPERATOR_MAX_REAL_USD_MICRO: "1000000" }).inference.realInferenceEnabled).toBe(false);
    expect(
      loadConfig({ ...baseEnv, OPERATOR_MAX_REAL_USD_MICRO: "1000000", OPENROUTER_API_KEY: "sk-test-not-real" })
        .inference.realInferenceEnabled,
    ).toBe(true);
    expect(() => loadConfig({ ...baseEnv, OPERATOR_MAX_REAL_USD_MICRO: "1.5" })).toThrow(VeiloConfigError);
    expect(() => loadConfig({ ...baseEnv, OPERATOR_MAX_REAL_USD_MICRO: "-1" })).toThrow(VeiloConfigError);
  });

  it("never includes secret values in the printable summary or validation errors", () => {
    const secret = "sk-or-v1-should-never-appear";
    const summary = JSON.stringify(describeConfig(loadConfig({ ...baseEnv, OPENROUTER_API_KEY: secret })));
    expect(summary).not.toContain(secret);
    try {
      loadConfig({ ...baseEnv, OPENROUTER_API_KEY: secret, DEVNET_RPC_URL: "not a url" });
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(secret);
    }
  });
});

describe("NET-01 live chain identity check (mocked RPC)", () => {
  const config = loadConfig(baseEnv);

  it("accepts devnet genesis and a six-decimal SPL Token mint", async () => {
    const rpc = mockRpc();
    const result = await verifyChainIdentity(config, rpc.fetch);
    expect(result).toMatchObject({ genesisHash: DEVNET_GENESIS_HASH, mintDecimals: 6, mintOwner: SPL_TOKEN_PROGRAM_ID });
    expect(rpc.calls.map((c) => c.method)).toEqual(["getGenesisHash", "getAccountInfo"]);
    expect(rpc.calls[1]?.params[1]).toMatchObject({ commitment: "finalized", encoding: "base64" });
  });

  it("rejects an RPC endpoint reporting the mainnet genesis", async () => {
    const rpc = mockRpc({ genesis: MAINNET_GENESIS_HASH });
    await expectCode(verifyChainIdentity(config, rpc.fetch), "WRONG_NETWORK");
    expect(rpc.calls.map((c) => c.method)).toEqual(["getGenesisHash"]);
  });

  it("rejects an unknown genesis hash", async () => {
    await expectCode(
      verifyChainIdentity(config, mockRpc({ genesis: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY" }).fetch),
      "WRONG_NETWORK",
    );
  });

  it("rejects a missing mint account", async () => {
    await expectCode(verifyChainIdentity(config, mockRpc({ missingMint: true }).fetch), "WRONG_MINT");
  });

  it("rejects a mint owned by Token-2022", async () => {
    await expectCode(verifyChainIdentity(config, mockRpc({ owner: TOKEN_2022 }).fetch), "WRONG_MINT");
  });

  it("rejects a mint with the wrong decimals", async () => {
    await expectCode(verifyChainIdentity(config, mockRpc({ data: mintData({ decimals: 9 }) }).fetch), "WRONG_MINT");
  });

  it("rejects an uninitialized mint", async () => {
    await expectCode(verifyChainIdentity(config, mockRpc({ data: mintData({ initialized: 0 }) }).fetch), "WRONG_MINT");
  });

  it("rejects an account that is not mint-sized", async () => {
    await expectCode(verifyChainIdentity(config, mockRpc({ data: mintData({ size: 165 }) }).fetch), "WRONG_MINT");
  });

  it("fails closed when the RPC is unreachable", async () => {
    const failing: FetchLike = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    await expectCode(verifyChainIdentity(config, failing), "RPC_UNAVAILABLE");
  });

  it("fails closed on an RPC error response", async () => {
    const erroring: FetchLike = async (_u, init) => {
      const { id } = JSON.parse(String(init.body)) as { id: number };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "boom" } }));
    };
    await expectCode(verifyChainIdentity(config, erroring), "RPC_UNAVAILABLE");
  });
});
