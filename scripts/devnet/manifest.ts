import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex, TOKEN_PROGRAM } from "./lib";

export const GENESIS_HEX = "ce59db5080fc2c6d3bcf7ca90712d3c2e5e6c28f27f0dfbb9953bdb0894c03ab";
const SCALAR_FIELD = "21888242871839275222246405745257275088548364400416034343698204186575808495617";
const ROOT_HISTORY_RULE = "spend/exit accept any of the newest 32 commitment roots; insert accepts only the current root; spend accepts only the current approved root";

export interface ManifestInput {
  rootDir: string;
  caip2: string;
  genesisHash: string;
  programId: string;
  programData: string;
  binary: Uint8Array;
  poolId: string;
  poolState: string;
  vaultAuthority: string;
  vault: string;
  approvalState: string;
  mint: string;
  freezeAuthority: string | null;
  /** Values read back from the initialized pool (decimal strings). */
  pool: { emptyRoot: string; minDeposit: string; maxDeposit: string; liabilityCap: string; maxRelayerFee: string };
  authorities: { deployer: string; configAuthority: string; approvalAuthority: string; sponsor: string };
  signatures: { fundRoles?: string | null; deploy?: string | null; initializePool?: string | null; merchantAta?: string | null };
  gateway: { merchantAddress: string; merchantAta: string; facilitatorFeePayer: string };
  createdAt: string;
}

/** The deployment manifest document checked by the relayer and wallet (parseDeploymentManifest). */
export function deploymentManifest(i: ManifestInput) {
  const circuits = JSON.parse(readFileSync(join(i.rootDir, "artifacts", "circuits", "manifest.json"), "utf8")) as { circuits: Record<string, Record<string, unknown>> };
  const pick = (name: string) => {
    const c = circuits.circuits[name]!;
    const keys = ["name", "sourceSha256", "circomVersion", "compilerFlags", "constraints", "nPublic", "publicInputOrder", "r1csSha256", "wasmSha256", "zkeySha256", "vkeyJsonSha256", "vkRustSha256", "ptau", "setup"];
    return Object.fromEntries(keys.map((k) => [k, c[k]]));
  };
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    encodingVersion: "v1",
    network: { cluster: "devnet", caip2: i.caip2, genesisHash: i.genesisHash, genesisHashHex: GENESIS_HEX },
    program: {
      programId: i.programId,
      programDataAddress: i.programData,
      upgradeAuthority: i.authorities.deployer,
      binarySha256: sha256Hex(i.binary),
      binaryBytes: i.binary.length,
      maxLen: i.binary.length,
      sbpfVersion: "v3",
      anchorVersion: "1.2.1",
      solanaToolsVersion: "agave 4.1.2, platform-tools v1.57",
      rustToolchain: "1.97.1",
      groth16SolanaVersion: "0.2.0",
      deploySignature: i.signatures.deploy ?? "",
    },
    pool: { poolId: i.poolId, poolState: i.poolState, vaultAuthority: i.vaultAuthority, vault: i.vault, approvalState: i.approvalState, initSignature: i.signatures.initializePool ?? "" },
    token: { mint: i.mint, decimals: 6, tokenProgram: TOKEN_PROGRAM, mintKind: "devnet-usdc", freezeAuthority: i.freezeAuthority },
    crypto: {
      curve: "bn254",
      scalarField: SCALAR_FIELD,
      proofSystem: "groth16",
      hash: { name: "poseidon-circomlib", sbox: 5, fullRounds: 8, partialRounds: { "2": 57, "3": 56 }, arities: [2, 3] },
      labelDomain: "veilo/label/v1",
      intentDomain: "veilo/intent/v1",
      contextHash: "sha256-first31-be",
      vectorsFile: "artifacts/vectors/v1.json",
      vectorsSha256: sha256Hex(new Uint8Array(readFileSync(join(i.rootDir, "artifacts", "vectors", "v1.json")))),
    },
    trees: { commitmentDepth: 16, approvedDepth: 16, rootHistory: 32, emptyRoot: i.pool.emptyRoot, capacity: 65536, changeReserve: 1024, queueMaxLiveDeposits: 64 },
    circuits: { spend: pick("spend"), insert: pick("insert"), exit: pick("exit") },
    bounds: {
      minDeposit: i.pool.minDeposit,
      maxDeposit: i.pool.maxDeposit,
      liabilityCap: i.pool.liabilityCap,
      maxRelayerFee: i.pool.maxRelayerFee,
      maxIntentSlots: 750,
      hardMaxDeposit: "20000000",
      hardLiabilityCap: "100000000",
      hardMaxRelayerFee: "100000",
    },
    authorities: {
      deployer: i.authorities.deployer,
      configAuthority: i.authorities.configAuthority,
      approvalAuthority: i.authorities.approvalAuthority,
      sponsor: i.authorities.sponsor,
      relayer: i.authorities.sponsor,
    },
    rootHistoryRule: ROOT_HISTORY_RULE,
    signatures: Object.fromEntries(
      [
        ["fundRoles", i.signatures.fundRoles],
        ["deploy", i.signatures.deploy],
        ["initializePool", i.signatures.initializePool],
        ["merchantAta", i.signatures.merchantAta],
      ].filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""),
    ),
    gateway: i.gateway,
    createdAt: i.createdAt,
  };
}
