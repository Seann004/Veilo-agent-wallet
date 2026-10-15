import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
} from "@solana/kit";
import type { PublicStateWire } from "@veilo/contracts/relayer";
import {
  approvedPathFor,
  buildApprovedTree,
  decodeApprovalState,
  decodePoolState,
  hexToBytes,
  MerkleTree,
  parseDecimal,
  TREE_DEPTH,
  type DeploymentManifest,
  type MerklePath,
  type PoolStateAccount,
  type Poseidon,
} from "@veilo/privacy-sdk";
import { WalletError } from "./errors";
import type { ChainPort, RelayerPort } from "./ports";

/** Deployed pool addresses, taken from the verified deployment manifest. */
export interface PoolContext {
  programId: Address;
  poolState: Address;
  vault: Address;
  vaultAuthority: Address;
  approvalState: Address;
  mint: Address;
  genesisHash: Uint8Array;
  relayer: Address;
  sponsor: Address;
  maxIntentSlots: bigint;
}

export function poolContextFrom(m: DeploymentManifest): PoolContext {
  return {
    programId: address(m.program.programId),
    poolState: address(m.pool.poolState),
    vault: address(m.pool.vault),
    vaultAuthority: address(m.pool.vaultAuthority),
    approvalState: address(m.pool.approvalState),
    mint: address(m.token.mint),
    genesisHash: hexToBytes(m.network.genesisHashHex),
    relayer: address(m.authorities.relayer),
    sponsor: address(m.authorities.sponsor),
    maxIntentSlots: 750n,
  };
}

/** Public state rebuilt locally and checked against finalized on-chain roots. */
export interface VerifiedPublicState {
  view: PublicStateWire;
  finalizedSlot: bigint;
  pool: PoolStateAccount;
  tree: MerkleTree;
  approvedTree: MerkleTree;
  leafIndexOf(commitment: bigint): number | null;
  statePath(commitment: bigint): MerklePath | null;
  approvedPath(label: bigint): MerklePath | null;
  isApproved(label: bigint): boolean;
}

/**
 * Rebuilds the commitment and approved trees from the indexer's replay and accepts them only if
 * both roots equal the finalized on-chain PoolState / ApprovalState. An indexer-supplied root
 * alone is never trusted.
 */
export async function verifiedPublicState(p: Poseidon, ctx: PoolContext, relayer: RelayerPort, chain: ChainPort): Promise<VerifiedPublicState> {
  const view = await relayer.publicState();
  if (!view.consistent) throw new WalletError("NOT_READY", `indexer replay disagrees with chain (${view.mismatches.join(", ")})`);
  if (view.pool.poolState !== ctx.poolState) throw new WalletError("RECOVERY_REQUIRED", "indexer serves a different pool");
  const tree = new MerkleTree(p, TREE_DEPTH);
  const ordered = [...view.leaves].sort((a, b) => a.index - b.index);
  ordered.forEach((l, i) => {
    if (l.index !== i) throw new WalletError("NOT_READY", "indexer leaf list has gaps");
    tree.append(parseDecimal(l.commitment));
  });
  const approvedTree = buildApprovedTree(p, view.approved.labels.map(parseDecimal));
  const poolAcct = await chain.account(ctx.poolState);
  const approvalAcct = await chain.account(ctx.approvalState);
  if (!poolAcct || !approvalAcct) throw new WalletError("NOT_READY", "pool accounts are not visible at finalized commitment");
  const pool = decodePoolState(poolAcct.data);
  const approval = decodeApprovalState(approvalAcct.data);
  if (tree.root !== pool.currentRoot || BigInt(tree.size) !== pool.nextLeafIndex) {
    throw new WalletError("NOT_READY", "rebuilt commitment tree does not match the finalized on-chain root; waiting for pool state");
  }
  const approvedOk = view.approved.consistent && approvedTree.root === approval.approvedRoot;
  const index = new Map(ordered.map((l) => [parseDecimal(l.commitment), l.index]));
  return {
    view,
    finalizedSlot: BigInt(view.finalizedSlot),
    pool,
    tree,
    approvedTree,
    leafIndexOf: (c) => index.get(c) ?? null,
    statePath: (c) => {
      const i = index.get(c);
      return i === undefined ? null : tree.path(i);
    },
    approvedPath: (label) => (approvedOk ? approvedPathFor(approvedTree, label) : null),
    isApproved: (label) => approvedOk && approvedPathFor(approvedTree, label) !== null,
  };
}

/** Unsigned v0 wire transaction (all signature slots zero) for an external signer such as Phantom. */
export function unsignedTransaction(feePayer: Address, blockhash: { blockhash: string; lastValidBlockHeight: bigint }, instructions: Instruction[]): string {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash.blockhash as Blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return getBase64EncodedWireTransaction(compileTransaction(msg));
}

export const PRIVACY_WARNINGS = {
  exit:
    "Public exit is linkable: it reveals this note's label (and so its original deposit), its value and your refund address on-chain. Spending since the deposit can be inferred by subtraction. The exit does not need operator approval and works during an emergency stop.",
  recovery:
    "Recovery moves the fresh payment wallet's remaining tokens to your configured recovery account in a public transaction. It links that fresh wallet to your account and does not restore the original privacy.",
  deposit:
    "Deposit amount, source account and timing are public. A pool with few participants or a distinctive amount gives weak practical privacy.",
} as const;
