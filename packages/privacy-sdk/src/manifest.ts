import { isAddress } from "@solana/kit";
import { EncodingError } from "./field";

/** Subset of the deployment manifest (protocol section 10) that off-chain services pin. */
export interface DeploymentManifest {
  schemaVersion: 1;
  protocolVersion: 1;
  encodingVersion: "v1";
  network: { cluster: "devnet"; caip2: string; genesisHash: string; genesisHashHex: string };
  program: { programId: string; programDataAddress: string; upgradeAuthority: string | null; binarySha256: string };
  pool: { poolId: string; poolState: string; vaultAuthority: string; vault: string; approvalState: string };
  token: { mint: string; decimals: 6; tokenProgram: string };
  crypto: { vectorsSha256: string };
  trees: { commitmentDepth: number; approvedDepth: number; rootHistory: number; emptyRoot: string };
  circuits: Record<"spend" | "insert" | "exit", { wasmSha256: string; zkeySha256: string; vkeyJsonSha256: string; publicInputOrder: string[] }>;
  bounds: { maxRelayerFee: string; maxIntentSlots: 750 };
  authorities: { approvalAuthority: string; sponsor: string; relayer: string; configAuthority: string; deployer: string };
  [key: string]: unknown;
}

export const DEVNET_CAIP2_ID = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const DEVNET_GENESIS_HASH_HEX = "ce59db5080fc2c6d3bcf7ca90712d3c2e5e6c28f27f0dfbb9953bdb0894c03ab";

export class ManifestMismatchError extends Error {
  override readonly name = "ManifestMismatchError";
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const hex64 = /^[0-9a-f]{64}$/;

function need(cond: boolean, what: string): void {
  if (!cond) throw new ManifestMismatchError(`deployment manifest: ${what}`);
}

/** Structural validation of the fields services depend on. Unknown extra fields are allowed. */
export function parseDeploymentManifest(json: unknown): DeploymentManifest {
  need(isObj(json), "not an object");
  const m = json as Record<string, unknown>;
  need(m.schemaVersion === 1 && m.protocolVersion === 1 && m.encodingVersion === "v1", "version mismatch");
  const net = m.network;
  need(
    isObj(net) && net.cluster === "devnet" && net.caip2 === DEVNET_CAIP2_ID && net.genesisHash === DEVNET_GENESIS && net.genesisHashHex === DEVNET_GENESIS_HASH_HEX,
    "network is not Solana devnet",
  );
  const addr = (v: unknown) => typeof v === "string" && isAddress(v);
  const prog = m.program;
  need(isObj(prog) && addr(prog.programId) && addr(prog.programDataAddress) && typeof prog.binarySha256 === "string" && hex64.test(prog.binarySha256), "program section invalid");
  const pool = m.pool;
  need(
    isObj(pool) && typeof pool.poolId === "string" && hex64.test(pool.poolId) && addr(pool.poolState) && addr(pool.vaultAuthority) && addr(pool.vault) && addr(pool.approvalState),
    "pool section invalid",
  );
  const token = m.token;
  need(isObj(token) && addr(token.mint) && token.decimals === 6 && token.tokenProgram === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "token section invalid");
  const trees = m.trees;
  need(isObj(trees) && trees.commitmentDepth === 16 && trees.approvedDepth === 16 && trees.rootHistory === 32, "tree parameters differ from protocol v1");
  const circuits = m.circuits;
  need(isObj(circuits), "circuits section missing");
  for (const name of ["spend", "insert", "exit"] as const) {
    const c = (circuits as Record<string, unknown>)[name];
    need(isObj(c) && hex64.test(String(c.wasmSha256)) && hex64.test(String(c.zkeySha256)) && hex64.test(String(c.vkeyJsonSha256)), `circuit ${name} hashes invalid`);
  }
  const bounds = m.bounds;
  need(isObj(bounds) && bounds.maxIntentSlots === 750 && typeof bounds.maxRelayerFee === "string", "bounds invalid");
  const auth = m.authorities;
  need(isObj(auth) && addr(auth.approvalAuthority) && addr(auth.sponsor) && addr(auth.relayer), "authorities invalid");
  return json as DeploymentManifest;
}

export interface ManifestExpectations {
  programId?: string | undefined;
  poolId?: string | undefined;
  mint: string;
  /** artifacts/circuits/manifest.json circuits section: the proving files this build pins. */
  circuitHashes: Record<"spend" | "insert" | "exit", { wasmSha256: string; zkeySha256: string; vkeyJsonSha256: string }>;
  vectorsSha256?: string;
}

/** Compares a deployment manifest with local configuration and pinned artifacts. Any mismatch is fatal. */
export function assertManifestMatches(m: DeploymentManifest, e: ManifestExpectations): void {
  const errs: string[] = [];
  if (e.programId !== undefined && m.program.programId !== e.programId) errs.push("program id differs from POOL_PROGRAM_ID");
  if (e.poolId !== undefined && m.pool.poolId !== e.poolId) errs.push("pool id differs from POOL_ID");
  if (m.token.mint !== e.mint) errs.push("mint differs from DEMO_TOKEN_MINT");
  for (const name of ["spend", "insert", "exit"] as const) {
    const a = m.circuits[name];
    const b = e.circuitHashes[name];
    if (a.wasmSha256 !== b.wasmSha256 || a.zkeySha256 !== b.zkeySha256 || a.vkeyJsonSha256 !== b.vkeyJsonSha256) {
      errs.push(`circuit ${name} artifacts differ from the pinned build`);
    }
  }
  if (e.vectorsSha256 !== undefined && m.crypto.vectorsSha256 !== e.vectorsSha256) errs.push("vector file hash differs");
  if (errs.length > 0) throw new ManifestMismatchError(`deployment manifest mismatch: ${errs.join("; ")}`);
}

export function poolIdBytes(m: DeploymentManifest): Uint8Array {
  if (!hex64.test(m.pool.poolId)) throw new EncodingError("pool id must be 32 bytes hex");
  return new Uint8Array(Buffer.from(m.pool.poolId, "hex"));
}
