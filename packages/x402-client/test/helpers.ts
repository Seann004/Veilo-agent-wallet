import {
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
  type TransactionSigner,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from "@solana-program/compute-budget";
import { getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { DEMO_TOKEN_MINT } from "@veilo/contracts";
import { deriveAta } from "../src/ata";
import { MEMO_PROGRAM } from "../src/validate-transaction";

export const MINT = address(DEMO_TOKEN_MINT);

export interface Parties {
  payer: KeyPairSigner;
  feePayer: KeyPairSigner;
  merchant: KeyPairSigner;
  merchantAta: Address;
  payerAta: Address;
  blockhash: Blockhash;
}

export async function makeParties(): Promise<Parties> {
  const [payer, feePayer, merchant, bh] = await Promise.all([
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
  ]);
  return {
    payer,
    feePayer,
    merchant,
    merchantAta: await deriveAta(merchant.address, MINT),
    payerAta: await deriveAta(payer.address, MINT),
    blockhash: bh.address as unknown as Blockhash,
  };
}

export interface BuildOptions {
  amount?: bigint;
  destination?: Address;
  source?: Address;
  authority?: TransactionSigner;
  feePayer?: Address;
  units?: number;
  microLamports?: bigint;
  decimals?: number;
  mint?: Address;
  memo?: string | null;
  extra?: Instruction[];
  replace?: (ixs: Instruction[]) => Instruction[];
}

export function memoInstruction(text: string): Instruction {
  return { programAddress: address(MEMO_PROGRAM), data: new TextEncoder().encode(text) };
}

/** Builds and partially signs a transaction in the SDK's exact layout, with overrides. */
export async function buildPaymentTx(p: Parties, o: BuildOptions = {}): Promise<string> {
  const authority = o.authority ?? p.payer;
  let ixs: Instruction[] = [
    getSetComputeUnitLimitInstruction({ units: o.units ?? 20_000 }),
    getSetComputeUnitPriceInstruction({ microLamports: o.microLamports ?? 1n }),
    getTransferCheckedInstruction(
      {
        source: o.source ?? p.payerAta,
        mint: o.mint ?? MINT,
        destination: o.destination ?? p.merchantAta,
        authority,
        amount: o.amount ?? 100_000n,
        decimals: o.decimals ?? 6,
      },
      { programAddress: TOKEN_PROGRAM_ADDRESS },
    ),
  ];
  const memo = o.memo === undefined ? "0123456789abcdef0123456789abcdef" : o.memo;
  if (memo !== null) ixs.push(memoInstruction(memo));
  if (o.extra) ixs.push(...o.extra);
  if (o.replace) ixs = o.replace(ixs);
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(o.feePayer ?? p.feePayer.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: p.blockhash, lastValidBlockHeight: 1000n }, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const signed = await partiallySignTransactionMessageWithSigners(message);
  return getBase64EncodedWireTransaction(signed);
}
