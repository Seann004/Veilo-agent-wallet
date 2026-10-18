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
import { getSwapV2InstructionDataDecoder, SWAP_V2_DISCRIMINATOR } from "@orca-so/whirlpools-client";
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
 * Why the quoted instruction is not exactly the swap the wallet means to sign (an Orca swapV2
 * selling exactly `amount` of the fresh wallet's USDC on the pinned whirlpool for at least
 * `minOut` lamports of wrapped SOL), or null when it is.
 */
export async function swapInstructionMismatch(ix: Instruction, e: { fresh: Address; usdcMint: Address; amount: bigint; minOut: bigint }): Promise<string | null> {
  const data = ix.data ?? new Uint8Array();
  if (ix.programAddress !== ORCA_WHIRLPOOL_PROGRAM || data.length < 8 || !SWAP_V2_DISCRIMINATOR.every((b, i) => data[i] === b)) return "not an Orca swapV2 instruction";
  const a = (ix.accounts ?? []).map((m) => m.address);
  const freshUsdc = (await associatedTokenAddress(e.fresh, e.usdcMint)).address;
  const freshWsol = (await associatedTokenAddress(e.fresh, address(WRAPPED_SOL_MINT))).address;
  if (a[3] !== e.fresh || a[4] !== DEVNET_SOL_USDC_WHIRLPOOL || a[5] !== WRAPPED_SOL_MINT || a[6] !== e.usdcMint || a[7] !== freshWsol || a[9] !== freshUsdc) {
    return "swap does not use the pinned whirlpool and the fresh wallet's own token accounts";
  }
  let args;
  try {
    args = getSwapV2InstructionDataDecoder().decode(data);
  } catch {
    return "swap instruction data does not decode";
  }
  if (args.aToB || !args.amountSpecifiedIsInput) return "swap does not sell an exact USDC input for SOL";
  if (args.amount !== e.amount) return "swap input differs from the funded amount";
  if (args.otherAmountThreshold !== e.minOut) return "swap minimum output differs from the quote";
  return null;
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
