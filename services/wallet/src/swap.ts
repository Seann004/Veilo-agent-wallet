import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
  type Transaction,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { getCloseAccountInstruction, getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token";
import { setNativeMintWrappingStrategy, swapInstructions, WhirlpoolDeployment } from "@orca-so/whirlpools";
import { createDevnetRpc, DEVNET_SOL_USDC_WHIRLPOOL, ORCA_WHIRLPOOL_PROGRAM, WRAPPED_SOL_MINT } from "@veilo/contracts";
import { associatedTokenAddress } from "@veilo/privacy-sdk";

const SWAP_COMPUTE_UNITS = 400_000;

/** One quoted Orca swap: its swapV2 instruction and the amounts it guarantees and expects. */
export interface SwapQuote {
  swapIx: Instruction;
  minOutLamports: bigint;
  estOutLamports: bigint;
}

/** Quotes selling exactly `inputAmount` USDC from the fresh wallet on the pinned whirlpool. */
export interface SwapQuoter {
  quote(input: { fresh: Address; usdcMint: Address; inputAmount: bigint; slippageBps: number }): Promise<SwapQuote>;
}

/**
 * Orca SDK quoter. The SDK's own account setup would make the fresh wallet (which holds no SOL)
 * pay rent, so only its swapV2 instruction is kept; buildSwapTransaction adds the rest.
 */
export class OrcaSwapQuoter implements SwapQuoter {
  readonly #rpc: ReturnType<typeof createDevnetRpc>;

  constructor(rpcUrl: string) {
    this.#rpc = createDevnetRpc(rpcUrl);
  }

  async quote(input: { fresh: Address; usdcMint: Address; inputAmount: bigint; slippageBps: number }): Promise<SwapQuote> {
    setNativeMintWrappingStrategy("ata");
    const built = await swapInstructions(
      this.#rpc as unknown as Parameters<typeof swapInstructions>[0],
      { inputAmount: input.inputAmount, mint: input.usdcMint },
      address(DEVNET_SOL_USDC_WHIRLPOOL),
      { slippageToleranceBps: input.slippageBps, signer: createNoopSigner(input.fresh), whirlpoolDeployment: WhirlpoolDeployment.devnet },
    );
    const swapIx = built.instructions.find((i) => i.programAddress === ORCA_WHIRLPOOL_PROGRAM);
    if (!swapIx) throw new Error("the Orca SDK returned no swap instruction");
    const q = built.quote as { tokenMinOut: bigint; tokenEstOut: bigint };
    return { swapIx, minOutLamports: q.tokenMinOut, estOutLamports: q.tokenEstOut };
  }
}

/**
 * The exact transaction the relayer co-signs: compute limit; sponsor creates the fresh wallet's
 * wrapped-SOL account; the swap; the wrapped SOL unwrapped to `destination`; the emptied USDC
 * account closed with rent to the sponsor. The sponsor is fee payer and signs at the relayer.
 */
export async function buildSwapTransaction(p: {
  sponsor: Address;
  fresh: Address;
  usdcMint: Address;
  swapIx: Instruction;
  destination: Address;
  blockhash: string;
  lastValidBlockHeight: bigint;
}): Promise<Transaction> {
  const fresh = createNoopSigner(p.fresh);
  const freshUsdc = (await associatedTokenAddress(p.fresh, p.usdcMint)).address;
  const freshWsol = (await associatedTokenAddress(p.fresh, address(WRAPPED_SOL_MINT))).address;
  const ixs: Instruction[] = [
    getSetComputeUnitLimitInstruction({ units: SWAP_COMPUTE_UNITS }),
    getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(p.sponsor), ata: freshWsol, owner: p.fresh, mint: address(WRAPPED_SOL_MINT) }),
    p.swapIx,
    getCloseAccountInstruction({ account: freshWsol, destination: p.destination, owner: fresh }),
    getCloseAccountInstruction({ account: freshUsdc, destination: p.sponsor, owner: fresh }),
  ];
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(p.sponsor, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: p.blockhash as Blockhash, lastValidBlockHeight: p.lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  return compileTransaction(msg);
}
