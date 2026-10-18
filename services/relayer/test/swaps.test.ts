import { describe, expect, it } from "vitest";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { getCloseAccountInstruction, getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token";
import { getSwapV2Instruction } from "@orca-so/whirlpools-client";
import { DEVNET_SOL_USDC_WHIRLPOOL, ORCA_WHIRLPOOL_PROGRAM, WRAPPED_SOL_MINT } from "@veilo/contracts";
import { associatedTokenAddress } from "@veilo/privacy-sdk";
import { openRelayerDb, sponsorTotals } from "../src/db";
import { SwapService } from "../src/swaps";
import { FakeRelayerChain, randomAddress, spendVk, testManifest, testSponsor } from "./fixtures";

type Sponsor = Awaited<ReturnType<typeof testSponsor>>;
type Manifest = Awaited<ReturnType<typeof testManifest>>;
type Tamper = { pool?: Address; closeUsdcTo?: Address; aToB?: boolean; extra?: boolean; sign?: boolean; payer?: Address };

async function swapTx(sponsor: Sponsor, m: Manifest, destination: Address, t: Tamper = {}) {
  const kp = await generateKeyPairSigner();
  const fresh = kp.address;
  const usdc = address(m.token.mint);
  const freshUsdc = (await associatedTokenAddress(fresh, usdc)).address;
  const freshWsol = (await associatedTokenAddress(fresh, address(WRAPPED_SOL_MINT))).address;
  const signer = createNoopSigner(fresh);
  const sponsorSigner = createNoopSigner(t.payer ?? sponsor.address);
  const ixs: Instruction[] = [
    getSetComputeUnitLimitInstruction({ units: 400_000 }),
    getCreateAssociatedTokenIdempotentInstruction({ payer: sponsorSigner, ata: freshWsol, owner: fresh, mint: address(WRAPPED_SOL_MINT) }),
    getSwapV2Instruction(
      {
        tokenProgramA: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        tokenProgramB: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        memoProgram: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
        tokenAuthority: signer,
        whirlpool: t.pool ?? address(DEVNET_SOL_USDC_WHIRLPOOL),
        tokenMintA: address(WRAPPED_SOL_MINT),
        tokenMintB: usdc,
        tokenOwnerAccountA: freshWsol,
        tokenVaultA: randomAddress(),
        tokenOwnerAccountB: freshUsdc,
        tokenVaultB: randomAddress(),
        tickArray0: randomAddress(),
        tickArray1: randomAddress(),
        tickArray2: randomAddress(),
        oracle: randomAddress(),
        amount: 1_000_000n,
        otherAmountThreshold: 70_000_000n,
        sqrtPriceLimit: 0,
        amountSpecifiedIsInput: true,
        aToB: t.aToB ?? false,
        remainingAccountsInfo: null,
      },
      { programAddress: address(ORCA_WHIRLPOOL_PROGRAM) },
    ),
    getCloseAccountInstruction({ account: freshWsol, destination, owner: signer }),
    getCloseAccountInstruction({ account: freshUsdc, destination: t.closeUsdcTo ?? sponsor.address, owner: signer }),
    ...(t.extra ? [getCloseAccountInstruction({ account: randomAddress(), destination: randomAddress(), owner: signer })] : []),
  ];
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (x) => setTransactionMessageFeePayer(t.payer ?? sponsor.address, x),
    (x) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: randomAddress() as unknown as Blockhash, lastValidBlockHeight: 10n }, x),
    (x) => appendTransactionMessageInstructions(ixs, x),
  );
  const compiled = compileTransaction(msg);
  const tx = t.sign === false ? compiled : await partiallySignTransaction([kp.keyPair], compiled);
  return { fresh, freshUsdc, wire: getBase64EncodedWireTransaction(tx) };
}

describe("devnet swap co-signing", () => {
  async function setup(cap = 100_000_000n) {
    const sponsor = await testSponsor();
    const m = await testManifest(sponsor.address);
    const chain = new FakeRelayerChain();
    const db = openRelayerDb(":memory:");
    chain.db = db;
    return { sponsor, m, chain, db, svc: new SwapService({ db, chain, sponsor, manifest: () => m, spendVk: spendVk(), sponsorCapLamports: cap }) };
  }
  let n = 0;
  const id = () => `6f1c1b7e-0000-4000-8000-${String(++n).padStart(12, "0")}`;

  it("co-signs only the pinned-pool swap that unwraps to the destination and returns USDC rent to the sponsor", async () => {
    const { sponsor, m, chain, db, svc } = await setup();
    const dest = randomAddress();
    const req = async (t: Tamper = {}) => {
      const s = await swapTx(sponsor, m, dest, t);
      chain.accounts.set(s.freshUsdc, { data: new Uint8Array(165), lamports: 2_039_280n, owner: "Tokenkeg", executable: false });
      return { swapId: id(), transaction: s.wire, lastValidBlockHeight: "10", freshWallet: s.fresh, destination: dest };
    };
    await expect(svc.submit(await req({ pool: randomAddress() }))).rejects.toThrow(/pinned whirlpool/);
    await expect(svc.submit(await req({ aToB: true }))).rejects.toThrow(/exact USDC amount/);
    await expect(svc.submit(await req({ closeUsdcTo: randomAddress() }))).rejects.toThrow(/rent to the sponsor/);
    await expect(svc.submit(await req({ extra: true }))).rejects.toThrow(/unexpected instructions/);
    await expect(svc.submit(await req({ sign: false }))).rejects.toThrow(/signature/);
    await expect(svc.submit(await req({ payer: randomAddress() }))).rejects.toThrow(/fee payer/);
    expect(chain.sent).toHaveLength(0);

    const ok = await svc.submit(await req());
    expect(ok.state).toBe("submitted");
    expect(chain.sent.at(-1)!.persistedSignatures).toContain(ok.signature);
    chain.statuses.set(ok.signature, { confirmationStatus: "finalized", err: null });
    chain.txs.set(ok.signature, { slot: 5n, err: null, logs: [], fee: 10_000n });
    await svc.advance(ok.swapId);
    expect(svc.view(ok.swapId)).toMatchObject({ state: "finalized", sponsorFeeLamports: "10000", sponsorRentLamports: "2039280", rentRecoveredLamports: "2039280" });
    const t = sponsorTotals(db);
    expect(t.feesSpent).toBe(10_000n);
    expect(t.rentRecovered).toBe(2_039_280n);
  });

  it("keeps a finalized swap in flight until its transaction (and fee) can be read", async () => {
    const { sponsor, m, chain, db, svc } = await setup();
    const dest = randomAddress();
    const s = await swapTx(sponsor, m, dest);
    chain.accounts.set(s.freshUsdc, { data: new Uint8Array(165), lamports: 2_039_280n, owner: "Tokenkeg", executable: false });
    const ok = await svc.submit({ swapId: id(), transaction: s.wire, lastValidBlockHeight: "10", freshWallet: s.fresh, destination: dest });
    chain.statuses.set(ok.signature, { confirmationStatus: "finalized", err: null });
    await svc.advance(ok.swapId);
    expect(svc.view(ok.swapId)!.state).toBe("submitted");
    expect(sponsorTotals(db).feesSpent).toBe(0n);
    chain.txs.set(ok.signature, { slot: 5n, err: null, logs: [], fee: 10_000n });
    await svc.advance(ok.swapId);
    expect(svc.view(ok.swapId)).toMatchObject({ state: "finalized", sponsorFeeLamports: "10000" });
    expect(sponsorTotals(db).feesSpent).toBe(10_000n);
  });

  it("refuses when the sponsor allowance cannot cover the wrapped-SOL rent", async () => {
    const { sponsor, m, chain, svc } = await setup(1_000n);
    const dest = randomAddress();
    const s = await swapTx(sponsor, m, dest);
    chain.accounts.set(s.freshUsdc, { data: new Uint8Array(165), lamports: 2_039_280n, owner: "Tokenkeg", executable: false });
    await expect(svc.submit({ swapId: id(), transaction: s.wire, lastValidBlockHeight: "10", freshWallet: s.fresh, destination: dest })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(chain.sent).toHaveLength(0);
  });

  it("counts swaps still in flight, so concurrent swaps cannot each fit the same allowance", async () => {
    const probe = await setup();
    const rent = await probe.chain.rentExemptMinimum(165);
    const { sponsor, m, chain, svc } = await setup(rent + 2n * 5_000n + 1n);
    const dest = randomAddress();
    const req = async () => {
      const s = await swapTx(sponsor, m, dest);
      chain.accounts.set(s.freshUsdc, { data: new Uint8Array(165), lamports: 2_039_280n, owner: "Tokenkeg", executable: false });
      return { swapId: id(), transaction: s.wire, lastValidBlockHeight: "10", freshWallet: s.fresh, destination: dest };
    };
    const [a, b] = await Promise.allSettled([svc.submit(await req()), svc.submit(await req())]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect(chain.sent).toHaveLength(1);
    await expect(svc.submit(await req())).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  it("returns the first submission's view to a concurrent retry of the same swap id near the allowance", async () => {
    const probe = await setup();
    const rent = await probe.chain.rentExemptMinimum(165);
    const { sponsor, m, chain, svc } = await setup(rent + 2n * 5_000n + 1n);
    const dest = randomAddress();
    const s = await swapTx(sponsor, m, dest);
    chain.accounts.set(s.freshUsdc, { data: new Uint8Array(165), lamports: 2_039_280n, owner: "Tokenkeg", executable: false });
    const req = { swapId: id(), transaction: s.wire, lastValidBlockHeight: "10", freshWallet: s.fresh, destination: dest };
    const [a, b] = await Promise.all([svc.submit(req), svc.submit(req)]);
    expect(b).toEqual(a);
    expect(a.state).toBe("submitted");
    expect(chain.sent).toHaveLength(1);
  });
});
