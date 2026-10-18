import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { address, createNoopSigner, getCompiledTransactionMessageDecoder, type Address, type Instruction } from "@solana/kit";
import { getSwapV2Instruction, getSwapV2InstructionDataDecoder } from "@orca-so/whirlpools-client";
import { associatedTokenAddress } from "@veilo/privacy-sdk";
import { advanceAuthority, recordFundingFinalized } from "@veilo/control/src/ledger/purchases";
import { DEVNET_SOL_USDC_WHIRLPOOL, ORCA_WHIRLPOOL_PROGRAM, SWAP_SLIPPAGE_BPS, WRAPPED_SOL_MINT, type FundingBinding, type FundingResult } from "@veilo/contracts";
import { decodeWireTransaction } from "@veilo/x402-client";
import { SWAP_SIGNATURE_PRODUCED } from "../src/funding";
import type { SwapQuoter } from "../src/swap";
import { authorize, BINDING, createWorld, depositAndApprove, fundingInput, randomAddress, type TestWallet, type World } from "./harness";

let world: World;
let w: TestWallet;
let quotes = 0;
type QuoteTamper = { pool?: Address; aToB?: boolean; amount?: bigint; threshold?: bigint; exactOut?: boolean };
let tamper: QuoteTamper = {};
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const quoter: SwapQuoter = {
  async quote({ fresh, usdcMint, inputAmount }) {
    quotes += 1;
    const swapIx: Instruction = getSwapV2Instruction(
      {
        tokenProgramA: TOKEN_PROGRAM,
        tokenProgramB: TOKEN_PROGRAM,
        memoProgram: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
        tokenAuthority: createNoopSigner(fresh),
        whirlpool: tamper.pool ?? address(DEVNET_SOL_USDC_WHIRLPOOL),
        tokenMintA: address(WRAPPED_SOL_MINT),
        tokenMintB: usdcMint,
        tokenOwnerAccountA: (await associatedTokenAddress(fresh, address(WRAPPED_SOL_MINT))).address,
        tokenVaultA: randomAddress(),
        tokenOwnerAccountB: (await associatedTokenAddress(fresh, usdcMint)).address,
        tokenVaultB: randomAddress(),
        tickArray0: randomAddress(),
        tickArray1: randomAddress(),
        tickArray2: randomAddress(),
        oracle: randomAddress(),
        amount: tamper.amount ?? inputAmount,
        otherAmountThreshold: tamper.threshold ?? 7_000_000n,
        sqrtPriceLimit: 0,
        amountSpecifiedIsInput: !tamper.exactOut,
        aToB: tamper.aToB ?? false,
        remainingAccountsInfo: null,
      },
      { programAddress: address(ORCA_WHIRLPOOL_PROGRAM) },
    );
    return { swapIx, minOutLamports: 7_000_000n, estOutLamports: 7_070_000n };
  },
};

beforeEach(async () => {
  world = await createWorld();
  w = world.open();
  w.deps.swapQuoter = quoter;
  quotes = 0;
  tamper = {};
});
afterEach(() => world.cleanup());

const ledger = () => world.control.env.ledger;
const SWAP = (): FundingBinding => ({
  ...BINDING,
  swap: { dex: "orca_whirlpool", whirlpool: DEVNET_SOL_USDC_WHIRLPOOL, inputMint: world.ctx.mint, outputMint: WRAPPED_SOL_MINT, slippageBps: SWAP_SLIPPAGE_BPS },
});

async function funded(key: string, binding: FundingBinding): Promise<string> {
  await depositAndApprove(world, w, 1_000_000n);
  const p = authorize(world, key);
  advanceAuthority(ledger(), p.id, "prepare_proof");
  expect((await w.funding.prepare({ ...fundingInput(world, p.id), binding })).status).toBe("prepared");
  advanceAuthority(ledger(), p.id, "release_proof");
  await w.funding.release(p.id, p.id);
  const fin = (await w.funding.status(p.id)) as Extract<FundingResult, { status: "finalized" }>;
  expect(fin.status).toBe("finalized");
  recordFundingFinalized(ledger(), p.id, { payout: fin.evidence.payout, tokenFees: fin.evidence.tokenFees, change: fin.evidence.change, changeCommitment: fin.evidence.changeCommitment, observedAtMs: fin.evidence.observedAtMs });
  return p.id;
}

describe("devnet swap signing", () => {
  it("signs nothing before control authorizes it, then signs once and unwraps only to the owner address", async () => {
    const binding = SWAP();
    const id = await funded("s1", binding);
    expect((await w.funding.signSwap(id, id, binding)).status).toBe("not_ready");
    expect(quotes).toBe(0);
    advanceAuthority(ledger(), id, "sign_merchant");
    const r = await w.funding.signSwap(id, id, binding);
    expect(r).toMatchObject({ status: "finalized", minOutLamports: 7_000_000n, destination: world.recoveryOwner, sponsorLamports: 2_049_280n });
    expect(await w.funding.signSwap(id, id, binding)).toEqual(r);
    expect(quotes).toBe(1);
    expect(world.relayer.swaps.size).toBe(1);
    expect(w.store.events(id).some((e) => e.kind === SWAP_SIGNATURE_PRODUCED)).toBe(true);

    const { req } = [...world.relayer.swaps.values()][0]!;
    expect(req.destination).toBe(world.recoveryOwner);
    const tx = decodeWireTransaction(req.transaction);
    const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    expect(msg.staticAccounts[0]).toBe(world.ctx.sponsor);
    expect(msg.instructions).toHaveLength(5);
    expect(tx.signatures[req.freshWallet]).toBeTruthy();
    expect(tx.signatures[world.ctx.sponsor]).toBeNull();
    expect(await w.funding.merchantOutcome(id)).toBe("finalized");
  });

  it("refuses a binding that is not the pinned swap, a changed binding and a missing owner address", async () => {
    const binding = SWAP();
    const id = await funded("s2", binding);
    advanceAuthority(ledger(), id, "sign_merchant");
    const otherPool = { ...binding, swap: { ...binding.swap!, whirlpool: randomAddress() } };
    expect((await w.funding.signSwap(id, id, otherPool)).status).toBe("recovery_required");
    expect((await w.funding.signSwap(id, id, BINDING)).status).toBe("recovery_required");
    w.deps.ownerRecoveryAddress = null;
    expect((await w.funding.signSwap(id, id, binding)).status).toBe("recovery_required");
    expect(quotes).toBe(0);
    expect(world.relayer.swaps.size).toBe(0);
  });

  it("reports a failed swap as failed and an expired one as unsettled, keeping the USDC recoverable", async () => {
    const binding = SWAP();
    world.relayer.swapOutcome = "failed";
    const failed = await funded("s3", binding);
    advanceAuthority(ledger(), failed, "sign_merchant");
    expect((await w.funding.signSwap(failed, failed, binding)).status).toBe("failed");
    expect(await w.funding.merchantOutcome(failed)).toBe("failed");

    world.relayer.swapOutcome = "expired";
    const expired = await funded("s4", binding);
    advanceAuthority(ledger(), expired, "sign_merchant");
    expect((await w.funding.signSwap(expired, expired, binding)).status).toBe("failed");
    expect(await w.funding.merchantOutcome(expired)).toBe("expired_unsettled");
  });

  it("refuses to sign a quoted swap that is not the intended sale on the pinned pool", async () => {
    const binding = SWAP();
    const id = await funded("s7", binding);
    advanceAuthority(ledger(), id, "sign_merchant");
    const cases: QuoteTamper[] = [{ pool: randomAddress() }, { aToB: true }, { exactOut: true }, { amount: 999_999n }, { threshold: 1n }];
    for (const t of cases) {
      tamper = t;
      const r = await w.funding.signSwap(id, id, binding);
      expect(r).toMatchObject({ status: "not_ready", reason: expect.stringMatching(/nothing was signed/) });
    }
    expect(w.store.swap(id)).toBeUndefined();
    expect(w.store.events(id).some((e) => e.kind === SWAP_SIGNATURE_PRODUCED)).toBe(false);
    expect(world.relayer.swaps.size).toBe(0);
    tamper = {};
    expect((await w.funding.signSwap(id, id, binding)).status).toBe("finalized");
  });

  it("swaps the whole balance when someone adds USDC to the public fresh-wallet account", async () => {
    const binding = SWAP();
    const id = await funded("s8", binding);
    advanceAuthority(ledger(), id, "sign_merchant");
    const f = w.store.funding(id)!;
    const ata = (await associatedTokenAddress(address(f.fresh_wallet), world.ctx.mint)).address;
    world.chain.balances.set(ata, f.payout - 1n);
    expect((await w.funding.signSwap(id, id, binding)).status).toBe("not_ready");
    expect(quotes).toBe(0);
    world.chain.balances.set(ata, f.payout + 1n);
    expect((await w.funding.signSwap(id, id, binding)).status).toBe("finalized");
    expect(w.store.swap(id)!.input_amount).toBe(f.payout + 1n);
    const { req } = [...world.relayer.swaps.values()][0]!;
    const msg = getCompiledTransactionMessageDecoder().decode(decodeWireTransaction(req.transaction).messageBytes);
    expect(getSwapV2InstructionDataDecoder().decode(new Uint8Array(msg.instructions[2]!.data!)).amount).toBe(f.payout + 1n);
  });

  it("keeps a signed swap and resubmits the same bytes when the relayer was down", async () => {
    const binding = SWAP();
    const id = await funded("s5", binding);
    advanceAuthority(ledger(), id, "sign_merchant");
    world.relayer.mode = "down";
    expect((await w.funding.signSwap(id, id, binding)).status).toBe("not_ready");
    const stored = w.store.swap(id)!;
    expect(stored.state).toBe("signed");
    world.relayer.mode = "land";
    expect((await w.funding.swapOutcome(id)).status).toBe("finalized");
    expect([...world.relayer.swaps.values()][0]!.req.transaction).toBe(stored.transaction_b64);
    expect(quotes).toBe(1);
  });

  it("marks a swap the relayer refused as failed instead of retrying it forever", async () => {
    const binding = SWAP();
    const id = await funded("s6", binding);
    advanceAuthority(ledger(), id, "sign_merchant");
    world.relayer.mode = "refuse_swap";
    const r = await w.funding.signSwap(id, id, binding);
    expect(r).toMatchObject({ status: "failed", signature: null });
    expect(w.store.swap(id)!.state).toBe("failed");
    world.relayer.mode = "land";
    expect(await w.funding.signSwap(id, id, binding)).toMatchObject({ status: "failed", signature: null });
    expect(await w.funding.merchantOutcome(id)).toBe("failed");
    expect(world.relayer.received.filter((b) => b.includes(w.store.swap(id)!.swap_id))).toHaveLength(1);
    expect(world.relayer.swaps.size).toBe(0);
    expect(quotes).toBe(1);
  });
});
