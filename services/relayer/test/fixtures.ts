import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  address,
  generateKeyPair,
  getAddressDecoder,
  getAddressFromPublicKey,
  getBase58Decoder,
  type Address,
} from "@solana/kit";
import { DEMO_TOKEN_MINT } from "@veilo/contracts";
import {
  encodeApprovalState,
  encodePoolState,
  getPoseidon,
  hexToBytes,
  MerkleTree,
  poolStatePda,
  type DeploymentManifest,
  type Poseidon,
} from "@veilo/privacy-sdk";
import type { VerificationKey } from "snarkjs";
import type { RelayerChain } from "../src/chain";
import type { RelayerDb } from "../src/db";
import type { SponsorKey } from "../src/sponsor";

export const REPO = resolve(import.meta.dirname, "../../..");
export const BUILD = join(REPO, "circuits", "build");
export const HAVE_CIRCUITS = existsSync(join(BUILD, "zkey", "spend_final.zkey")) && existsSync(join(BUILD, "spend", "spend_js", "spend.wasm"));
export const GENESIS_HEX = "ce59db5080fc2c6d3bcf7ca90712d3c2e5e6c28f27f0dfbb9953bdb0894c03ab";

export const fillAddr = (n: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(n));
export const randomAddress = (): Address => getAddressDecoder().decode(randomBytes(32));

export function circuitPins(): Record<"spend" | "insert" | "exit", { wasmSha256: string; zkeySha256: string; vkeyJsonSha256: string }> {
  return (JSON.parse(readFileSync(join(REPO, "artifacts", "circuits", "manifest.json"), "utf8")) as { circuits: never }).circuits;
}

export function spendVk(): VerificationKey {
  return JSON.parse(readFileSync(join(REPO, "artifacts", "circuits", "spend.vkey.json"), "utf8")) as VerificationKey;
}

export async function testSponsor(): Promise<SponsorKey> {
  const keyPair = await generateKeyPair();
  return { address: await getAddressFromPublicKey(keyPair.publicKey), keyPair };
}

export async function testManifest(sponsor: Address): Promise<DeploymentManifest> {
  const programId = fillAddr(0xaa);
  const pins = circuitPins();
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    encodingVersion: "v1",
    network: { cluster: "devnet", caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", genesisHashHex: GENESIS_HEX },
    program: { programId, programDataAddress: fillAddr(0xab), upgradeAuthority: null, binarySha256: "0".repeat(64) },
    pool: { poolId: "01".repeat(32), poolState: (await poolStatePda(programId, new Uint8Array(32).fill(1))).address, vaultAuthority: fillAddr(0x14), vault: fillAddr(0x13), approvalState: fillAddr(0x15) },
    token: { mint: DEMO_TOKEN_MINT, decimals: 6, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
    crypto: { vectorsSha256: "0".repeat(64) },
    trees: { commitmentDepth: 16, approvedDepth: 16, rootHistory: 32, emptyRoot: "0" },
    circuits: {
      spend: { ...pins.spend, publicInputOrder: [] },
      insert: { ...pins.insert, publicInputOrder: [] },
      exit: { ...pins.exit, publicInputOrder: [] },
    },
    bounds: { maxRelayerFee: "0", maxIntentSlots: 750 },
    authorities: { approvalAuthority: fillAddr(0x22), sponsor, relayer: sponsor, configAuthority: fillAddr(0x21), deployer: fillAddr(0x20) },
  };
}

/** Chain double. `sent` records each submitted wire transaction with the DB state at send time. */
export class FakeRelayerChain implements RelayerChain {
  slot = 400_000_000n;
  height = 300_000_000n;
  accounts = new Map<string, { data: Uint8Array; lamports: bigint; owner: string; executable: boolean }>();
  statuses = new Map<string, { confirmationStatus: "processed" | "confirmed" | "finalized"; err: unknown }>();
  txs = new Map<string, { slot: bigint; err: unknown; logs: string[]; fee: bigint; tokenTransfers?: Array<{ mint: string; destination: string; amount: bigint }> }>();
  sigsByAddress = new Map<string, Array<{ signature: string; slot: bigint; err: unknown }>>();
  sent: Array<{ wire: string; persistedSignatures: string[] }> = [];
  db: RelayerDb | null = null;

  async finalizedSlot() {
    return this.slot;
  }
  async finalizedBlockHeight() {
    return this.height;
  }
  async latestBlockhash() {
    return { blockhash: randomAddress() as string, lastValidBlockHeight: this.height + 150n };
  }
  async account(a: Address) {
    return this.accounts.get(a) ?? null;
  }
  async signaturesForAddress(a: Address) {
    return [...(this.sigsByAddress.get(a) ?? [])];
  }
  async transaction(sig: string) {
    return this.txs.get(sig) ?? null;
  }
  async signatureStatus(sig: string) {
    return this.statuses.get(sig) ?? null;
  }
  /** Devnet rent: 6,960 lamports per byte including the 128-byte account header. */
  async rentExemptMinimum(size: number) {
    return BigInt(size + 128) * 6_960n;
  }
  async send(wire: string) {
    const persisted = this.db
      ? [
          ...(this.db.prepare(`SELECT signature FROM withdrawal_attempt`).pluck().all() as string[]),
          ...(this.db.prepare(`SELECT signature FROM recovery`).pluck().all() as string[]),
          ...(this.db.prepare(`SELECT signature FROM crank_attempt`).pluck().all() as string[]),
          ...(this.db.prepare(`SELECT signature FROM swap`).pluck().all() as string[]),
        ]
      : [];
    this.sent.push({ wire, persistedSignatures: persisted });
  }
  addTx(addr: Address, logs: string[], err: unknown = null): string {
    const signature = getBase58Decoder().decode(randomBytes(64));
    const list = this.sigsByAddress.get(addr) ?? [];
    list.push({ signature, slot: this.slot, err });
    this.sigsByAddress.set(addr, list);
    this.txs.set(signature, { slot: this.slot, err, logs, fee: 5000n });
    return signature;
  }
}

/** Puts PoolState/ApprovalState for a tree and approved root on the fake chain. */
export function publishPool(chain: FakeRelayerChain, m: DeploymentManifest, s: { tree: MerkleTree; roots: bigint[]; approvedRoot: bigint; approvedVersion: bigint; head: bigint; tail: bigint; liability: bigint }): void {
  const roots = [...s.roots, ...Array(32 - s.roots.length).fill(0n)] as bigint[];
  chain.accounts.set(m.pool.poolState, {
    data: encodePoolState({
      protocolVersion: 1,
      bump: 255,
      vaultAuthorityBump: 255,
      mintDecimals: 6,
      depositsPaused: false,
      rootsLen: s.roots.length,
      rootsNext: s.roots.length % 32,
      poolId: new Uint8Array(32).fill(1),
      mint: address(m.token.mint),
      tokenProgram: address(m.token.tokenProgram),
      vault: address(m.pool.vault),
      genesisHash: hexToBytes(GENESIS_HEX),
      configAuthority: fillAddr(0x21),
      currentRoot: s.tree.root,
      rootHistory: roots,
      nextLeafIndex: BigInt(s.tree.size),
      queueHead: s.head,
      queueTail: s.tail,
      liability: s.liability,
      minDeposit: 100_000n,
      maxDeposit: 20_000_000n,
      liabilityCap: 100_000_000n,
      maxRelayerFee: 0n,
      cumulativeDeposited: s.liability,
      cumulativeOutflow: 0n,
    }),
    lamports: 1n,
    owner: m.program.programId,
    executable: false,
  });
  chain.accounts.set(m.pool.approvalState, {
    data: encodeApprovalState({ pool: address(m.pool.poolState), approvalAuthority: fillAddr(0x22), approvedRoot: s.approvedRoot, version: s.approvedVersion, updatedSlot: 1n, bump: 255 }),
    lamports: 1n,
    owner: m.program.programId,
    executable: false,
  });
}

export const poseidon = (): Promise<Poseidon> => getPoseidon();
