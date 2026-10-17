import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { address, type Address } from "@solana/kit";
import { VeiloConfigError, type VeiloConfig } from "@veilo/contracts";
import { openSecretsDatabase, secretsDatabasePath } from "@veilo/db";
import { assertManifestMatches, getPoseidon, ManifestMismatchError } from "@veilo/privacy-sdk";
import { createRpcChainPort, HttpControlPort, HttpRelayerPort, SnarkjsProver } from "./adapters";
import type { WalletDeps } from "./deps";
import { FundingService } from "./funding";
import { x402MerchantSigner } from "./merchant";
import { NoteService } from "./notes";
import { OwnerFlows } from "./owner-flows";
import { poolContextFrom, type PoolContext } from "./pool";
import { WalletKeys } from "./secret";
import { WalletStore } from "./store";

/** Reads a credential file; its contents are never logged. */
export function readCredential(path: string | undefined, what: string): string {
  if (path === undefined || !existsSync(path)) throw new VeiloConfigError("INVALID_CONFIG", `${what} credential file is not configured or missing`);
  const v = readFileSync(path, "utf8").trim();
  if (v.length < 32) throw new VeiloConfigError("INVALID_CONFIG", `${what} credential is shorter than 32 characters`);
  return v;
}

export function ownerRecoveryAddress(env: Record<string, string | undefined>): Address | null {
  const v = env.OWNER_RECOVERY_ADDRESS?.trim();
  if (!v) return null;
  try {
    return address(v);
  } catch {
    throw new VeiloConfigError("INVALID_CONFIG", "OWNER_RECOVERY_ADDRESS must be a base58 Solana address");
  }
}

export interface WalletRuntime {
  deps: WalletDeps;
  funding: FundingService;
  notes: NoteService;
  owner: OwnerFlows;
  controlCredentialDigest: string | null;
  close(): void;
}

export async function createWalletRuntime(config: VeiloConfig, env: Record<string, string | undefined>, repoRoot: string): Promise<WalletRuntime> {
  if (config.paths.ownerServiceSecret === undefined) throw new VeiloConfigError("INVALID_CONFIG", "OWNER_SERVICE_SECRET_PATH is not configured");
  const keys = WalletKeys.fromFile(config.paths.ownerServiceSecret);
  const db = openSecretsDatabase(secretsDatabasePath(config.paths.secretsDir), { controlDatabasePath: config.paths.controlDatabase });
  const store = new WalletStore(db, keys);
  const walletToken = readCredential(config.paths.serviceCredentials.wallet, "wallet service");
  const controlPath = config.paths.serviceCredentials.control;
  const controlCredentialDigest =
    controlPath !== undefined && existsSync(controlPath) ? createHash("sha256").update(readFileSync(controlPath, "utf8").trim(), "utf8").digest("hex") : null;
  const host = config.bindHost;
  const control = new HttpControlPort(env.VEILO_CONTROL_URL ?? `http://${host}:${config.ports.control}`, walletToken);
  const relayer = new HttpRelayerPort(env.VEILO_RELAYER_URL ?? `http://${host}:${config.ports.relayer}`, walletToken);
  const prover = new SnarkjsProver(repoRoot, env.VEILO_CIRCUIT_BUILD_DIR);
  let ctx: Promise<PoolContext> | undefined;
  const pool = () =>
    (ctx ??= relayer.deployment().then((m) => {
      assertManifestMatches(m, { programId: config.pool.programId, poolId: config.pool.poolId, mint: config.network.mint, circuitHashes: prover.circuitHashes() });
      return poolContextFrom(m);
    })).catch((error: unknown) => {
      // A transient relayer failure may be retried; a manifest mismatch stays fatal for proofs.
      if (!(error instanceof ManifestMismatchError)) ctx = undefined;
      throw error;
    });
  const deps: WalletDeps = {
    store,
    poseidon: await getPoseidon(),
    control,
    relayer,
    chain: createRpcChainPort(config.network.rpcUrl),
    prover,
    merchant: x402MerchantSigner(config.network.rpcUrl),
    pool,
    ownerRecoveryAddress: ownerRecoveryAddress(env),
    log: (line) => console.log(line),
  };
  const funding = new FundingService(deps);
  return {
    deps,
    funding,
    notes: new NoteService(deps),
    owner: new OwnerFlows(deps, funding),
    controlCredentialDigest,
    close: () => db.close(),
  };
}
