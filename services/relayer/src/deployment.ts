import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { address } from "@solana/kit";
import {
  assertManifestMatches,
  decodePoolState,
  EncodingError,
  hexToBytes,
  ManifestMismatchError,
  parseDeploymentManifest,
  poolIdBytes,
  sha256Hex,
  type DeploymentManifest,
} from "@veilo/privacy-sdk";
import type { RelayerChain } from "./chain";

export type DeploymentStatus =
  | { state: "missing"; reason: string }
  | { state: "mismatch"; reason: string; manifest: DeploymentManifest | null }
  | { state: "verified"; manifest: DeploymentManifest };

export interface CircuitPins {
  circuits: Record<"spend" | "insert" | "exit", { wasmSha256: string; zkeySha256: string; vkeyJsonSha256: string }>;
}

export function readCircuitPins(repoRoot: string): CircuitPins {
  return JSON.parse(readFileSync(join(repoRoot, "artifacts", "circuits", "manifest.json"), "utf8")) as CircuitPins;
}

/**
 * Loads the deployment manifest and checks it against configuration, the pinned circuit build
 * and the finalized chain (program executable, PoolState owned by it with the manifest's mint,
 * pool id and genesis). A mismatch is terminal: the relayer stops serving state or withdrawals.
 */
export async function verifyDeployment(o: {
  manifestPath: string;
  repoRoot: string;
  programId: string | undefined;
  poolId: string | undefined;
  mint: string;
  chain: RelayerChain;
}): Promise<DeploymentStatus> {
  if (!existsSync(o.manifestPath)) return { state: "missing", reason: "deployment manifest not found (pool not deployed yet)" };
  let manifest: DeploymentManifest | null = null;
  try {
    manifest = parseDeploymentManifest(JSON.parse(readFileSync(o.manifestPath, "utf8")));
    const pins = readCircuitPins(o.repoRoot);
    const vectors = join(o.repoRoot, "artifacts", "vectors", "v1.json");
    assertManifestMatches(manifest, {
      programId: o.programId,
      poolId: o.poolId,
      mint: o.mint,
      circuitHashes: pins.circuits,
      ...(existsSync(vectors) ? { vectorsSha256: sha256Hex(new Uint8Array(readFileSync(vectors))) } : {}),
    });
    const program = await o.chain.account(address(manifest.program.programId));
    if (!program?.executable) throw new ManifestMismatchError("program account is not an executable program on this cluster");
    const pool = await o.chain.account(address(manifest.pool.poolState));
    if (!pool || pool.owner !== manifest.program.programId) throw new ManifestMismatchError("PoolState is missing or not owned by the program");
    const ps = decodePoolState(pool.data);
    if (ps.mint !== manifest.token.mint) throw new ManifestMismatchError("on-chain pool mint differs from the manifest");
    if (Buffer.compare(Buffer.from(ps.poolId), Buffer.from(poolIdBytes(manifest))) !== 0) throw new ManifestMismatchError("on-chain pool id differs");
    if (Buffer.compare(Buffer.from(ps.genesisHash), Buffer.from(hexToBytes(manifest.network.genesisHashHex))) !== 0) {
      throw new ManifestMismatchError("on-chain pool genesis differs from devnet");
    }
    if (ps.vault !== manifest.pool.vault) throw new ManifestMismatchError("on-chain vault differs from the manifest");
    return { state: "verified", manifest };
  } catch (error) {
    if (error instanceof ManifestMismatchError || error instanceof SyntaxError || error instanceof EncodingError) return { state: "mismatch", reason: error.message, manifest };
    throw error;
  }
}
