import { address, generateKeyPairSigner } from "@solana/kit";
import { getApproveInstruction, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { DEVNET_CAIP2 } from "@veilo/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { deriveAta } from "../src/ata";
import { X402ClientError } from "../src/errors";
import { validateExactPaymentTransaction, type ExactPaymentExpectation } from "../src/validate-transaction";
import { buildPaymentTx, makeParties, memoInstruction, MINT, type Parties } from "./helpers";

let p: Parties;
let expectation: ExactPaymentExpectation;

beforeAll(async () => {
  p = await makeParties();
  expectation = {
    network: DEVNET_CAIP2,
    mint: MINT,
    amount: 100_000n,
    payTo: p.merchant.address,
    merchantAta: p.merchantAta,
    feePayers: [p.feePayer.address],
    payer: p.payer.address,
    recentBlockhash: p.blockhash,
    requirePayerSignature: true,
  };
});

async function expectReject(tx: string, reason: string, override: Partial<ExactPaymentExpectation> = {}) {
  const error = await validateExactPaymentTransaction(tx, { ...expectation, ...override }, deriveAta).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(X402ClientError);
  expect((error as X402ClientError).reason).toBe(reason);
}

describe("X402-02 complete exact SVM transaction validation", () => {
  it("accepts the SDK layout with the exact mint, amount, ATA, authority and fee payer", async () => {
    const tx = await buildPaymentTx(p);
    const v = await validateExactPaymentTransaction(tx, expectation, deriveAta);
    expect(v.amount).toBe(100_000n);
    expect(v.payer).toBe(p.payer.address);
    expect(v.feePayer).toBe(p.feePayer.address);
    expect(v.destination).toBe(p.merchantAta);
    expect(v.messageHash).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  it("rejects a wrong amount", async () => {
    await expectReject(await buildPaymentTx(p, { amount: 100_001n }), "amount_mismatch");
  });

  it("rejects a destination that is not the merchant ATA", async () => {
    const other = await generateKeyPairSigner();
    await expectReject(
      await buildPaymentTx(p, { destination: await deriveAta(other.address, MINT) }),
      "destination_not_merchant_ata",
    );
  });

  it("rejects the merchant owner address used directly as destination", async () => {
    await expectReject(await buildPaymentTx(p, { destination: p.merchant.address }), "destination_not_merchant_ata");
  });

  it("rejects an authority other than the fresh payer", async () => {
    const other = await generateKeyPairSigner();
    await expectReject(
      await buildPaymentTx(p, { authority: other, source: await deriveAta(other.address, MINT) }),
      "authority_not_fresh_payer",
    );
  });

  it("rejects a source account that is not the payer's ATA", async () => {
    const other = await generateKeyPairSigner();
    await expectReject(await buildPaymentTx(p, { source: await deriveAta(other.address, MINT) }), "source_not_payer_ata");
  });

  it("rejects a fee payer that is not the allowed facilitator", async () => {
    const other = await generateKeyPairSigner();
    await expectReject(await buildPaymentTx(p, { feePayer: other.address }), "fee_payer_not_allowed");
  });

  it("rejects the fee payer acting as transfer authority", async () => {
    await expectReject(
      await buildPaymentTx(p, { authority: p.feePayer, source: await deriveAta(p.feePayer.address, MINT) }),
      // A fee-payer authority collapses the signer set to one key.
      "signer_count_must_be_two",
      { payer: p.feePayer.address },
    );
  });

  it("rejects an extra transfer instruction", async () => {
    const extra = getTransferCheckedInstruction(
      { source: p.payerAta, mint: MINT, destination: p.merchantAta, authority: p.payer, amount: 1n, decimals: 6 },
      { programAddress: TOKEN_PROGRAM_ADDRESS },
    );
    await expectReject(await buildPaymentTx(p, { memo: null, extra: [extra] }), "unknown_instruction");
  });

  it("rejects an approve (delegate) instruction", async () => {
    const delegate = await generateKeyPairSigner();
    const approve = getApproveInstruction({ source: p.payerAta, delegate: delegate.address, owner: p.payer, amount: 1n });
    await expectReject(await buildPaymentTx(p, { memo: null, extra: [approve] }), "unknown_instruction");
  });

  it("rejects an approve placed in the transfer slot", async () => {
    const delegate = await generateKeyPairSigner();
    const approve = getApproveInstruction({ source: p.payerAta, delegate: delegate.address, owner: p.payer, amount: 100_000n });
    await expectReject(
      await buildPaymentTx(p, { replace: (ixs) => [ixs[0]!, ixs[1]!, approve, ixs[3]!] }),
      "not_transfer_checked",
    );
  });

  it("rejects more than four instructions", async () => {
    await expectReject(await buildPaymentTx(p, { extra: [memoInstruction("aa")] }), "instruction_count");
  });

  it("rejects an unknown program instruction", async () => {
    const unknown = { programAddress: address("11111111111111111111111111111111"), data: new Uint8Array([2, 0, 0, 0]) };
    await expectReject(await buildPaymentTx(p, { memo: null, extra: [unknown] }), "unknown_instruction");
  });

  it("rejects missing or reordered compute budget instructions", async () => {
    await expectReject(await buildPaymentTx(p, { replace: (ixs) => [ixs[1]!, ixs[0]!, ixs[2]!] }), "compute_limit_instruction");
  });

  it("rejects compute unit limits and prices above the caps", async () => {
    await expectReject(await buildPaymentTx(p, { units: 1_400_000 }), "compute_limit_too_high");
    await expectReject(await buildPaymentTx(p, { microLamports: 10_000_000n }), "compute_price_too_high");
  });

  it("rejects a wrong mint or decimals", async () => {
    const otherMint = (await generateKeyPairSigner()).address;
    await expectReject(await buildPaymentTx(p, { mint: otherMint }), "mint_mismatch");
    await expectReject(await buildPaymentTx(p, { decimals: 9 }), "decimals_mismatch");
  });

  it("rejects memos that could carry identifiers", async () => {
    await expectReject(await buildPaymentTx(p, { memo: "account:workspace-1" }), "memo_not_allowed");
  });

  it("rejects a blockhash other than the challenge's", async () => {
    const other = (await generateKeyPairSigner()).address;
    await expectReject(await buildPaymentTx(p), "blockhash_mismatch", { recentBlockhash: other });
  });

  it("rejects a missing payer signature when one is required", async () => {
    const tx = await buildPaymentTx(p);
    // Unsigned variant: same message, payer slot zeroed.
    const bytes = Buffer.from(tx, "base64");
    // Wire format: compact-u16 signature count (1 byte here), then 64-byte signatures; payer is slot 1.
    bytes.fill(0, 1 + 64, 1 + 128);
    await expectReject(bytes.toString("base64"), "payer_signature_missing");
  });

  it("rejects a corrupted payer signature", async () => {
    const bytes = Buffer.from(await buildPaymentTx(p), "base64");
    bytes[1 + 64 + 5] = (bytes[1 + 64 + 5]! + 1) % 256;
    await expectReject(bytes.toString("base64"), "payer_signature_invalid");
  });

  it("rejects mainnet expectations outright", async () => {
    await expectReject(await buildPaymentTx(p), "network_not_devnet", {
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    });
  });
});
