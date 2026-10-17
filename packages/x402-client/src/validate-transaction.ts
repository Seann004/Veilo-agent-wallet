import { createHash } from "node:crypto";
import {
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  verifySignature,
  type Address,
  type SignatureBytes,
  type Transaction,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { DEMO_TOKEN_DECIMALS, DEVNET_CAIP2 } from "@veilo/contracts";
import { X402ClientError } from "./errors";

export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

const SET_COMPUTE_UNIT_LIMIT = 2;
const SET_COMPUTE_UNIT_PRICE = 3;
const TRANSFER_CHECKED = 12;

/** Default caps; the SDK client emits 20,000 units at 1 micro-lamport. */
export const DEFAULT_MAX_COMPUTE_UNITS = 40_000;
export const DEFAULT_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 50_000n;
/** The SDK's random nonce memo: 16 bytes as lowercase hex. */
const NONCE_MEMO = /^[0-9a-f]{32}$/;

export interface ExactPaymentExpectation {
  network: string;
  mint: string;
  decimals?: number;
  amount: bigint;
  /** Merchant owner; the recipient ATA is derived from it. */
  payTo: string;
  merchantAta: string;
  /** Allowed facilitator fee payer(s). */
  feePayers: readonly string[];
  /** Fresh payment wallet that must be the sole transfer authority. Omit to accept any non-fee-payer payer. */
  payer?: string;
  /** Payer's ATA; when omitted it is derived from the payer and mint by the caller. */
  sourceAta?: string;
  recentBlockhash?: string;
  /** Exact memo the merchant approved; otherwise only the SDK nonce memo is allowed. */
  memo?: string;
  maxComputeUnits?: number;
  maxComputeUnitPriceMicroLamports?: bigint;
  /** Require a valid payer signature (post-sign checks). */
  requirePayerSignature?: boolean;
}

export interface ValidatedPayment {
  payer: Address;
  feePayer: Address;
  source: Address;
  destination: Address;
  mint: Address;
  amount: bigint;
  decimals: number;
  computeUnits: number;
  computeUnitPriceMicroLamports: bigint;
  memo: string | null;
  recentBlockhash: string;
  /** Base64 SHA-256 of the message bytes; the stable identity of this payment. */
  messageHash: string;
  messageBytes: Uint8Array;
}

function reject(reason: string, code: "POLICY_DENIED" | "WRONG_MINT" | "WRONG_NETWORK" | "PRICE_CHANGED" = "POLICY_DENIED"): never {
  throw new X402ClientError(code, reason);
}

export function decodeWireTransaction(input: Transaction | string): Transaction {
  if (typeof input !== "string") return input;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(getBase64Encoder().encode(input));
  } catch {
    return reject("transaction_not_base64");
  }
  try {
    return getTransactionDecoder().decode(bytes);
  } catch {
    return reject("transaction_undecodable");
  }
}

export function messageHashOf(messageBytes: Uint8Array): string {
  return createHash("sha256").update(messageBytes).digest("base64");
}

function readU32(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

function readU64(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);
}

/**
 * Full structural validation of an x402 exact SVM payment transaction. Accepts only:
 * SetComputeUnitLimit, SetComputeUnitPrice, one SPL Token TransferChecked and at most one
 * account-less memo, with exactly two signers (facilitator fee payer and payer). Everything
 * else (approvals, delegates, ALTs, extra transfers, unknown programs) is rejected.
 */
export async function validateExactPaymentTransaction(
  input: Transaction | string,
  expectation: ExactPaymentExpectation,
  resolveSourceAta: (payer: string, mint: string) => Promise<string>,
): Promise<ValidatedPayment> {
  if (expectation.network !== DEVNET_CAIP2) reject("network_not_devnet", "WRONG_NETWORK");
  const transaction = decodeWireTransaction(input);
  const messageBytes = new Uint8Array(transaction.messageBytes);
  let compiled: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>;
  try {
    compiled = getCompiledTransactionMessageDecoder().decode(messageBytes);
  } catch {
    return reject("message_undecodable");
  }

  if (compiled.version !== 0 && compiled.version !== "legacy") reject("unsupported_message_version");
  if ("addressTableLookups" in compiled && (compiled.addressTableLookups?.length ?? 0) > 0) {
    reject("address_lookup_tables_not_allowed");
  }

  const keys = compiled.staticAccounts.map((a) => a.toString());
  const { numSignerAccounts, numReadonlySignerAccounts, numReadonlyNonSignerAccounts } = compiled.header;
  if (numSignerAccounts !== 2) reject("signer_count_must_be_two");
  if (new Set(keys).size !== keys.length) reject("duplicate_static_accounts");

  const feePayer = keys[0];
  if (feePayer === undefined || !expectation.feePayers.includes(feePayer)) reject("fee_payer_not_allowed");
  const signers = keys.slice(0, numSignerAccounts);
  const isWritable = (index: number) =>
    index < numSignerAccounts
      ? index < numSignerAccounts - numReadonlySignerAccounts
      : index < keys.length - numReadonlyNonSignerAccounts;

  const instructions = compiled.instructions;
  if (instructions.length < 3 || instructions.length > 4) reject("instruction_count");
  const programOf = (i: number) => {
    const ix = instructions[i];
    const program = ix === undefined ? undefined : keys[ix.programAddressIndex];
    if (program === undefined) return reject("program_index_out_of_range");
    return program;
  };
  const dataOf = (i: number) => new Uint8Array(instructions[i]?.data ?? new Uint8Array());
  const accountsOf = (i: number) => instructions[i]?.accountIndices ?? [];

  // [0] SetComputeUnitLimit
  const limitData = dataOf(0);
  if (programOf(0) !== COMPUTE_BUDGET_PROGRAM || limitData.length !== 5 || limitData[0] !== SET_COMPUTE_UNIT_LIMIT) {
    reject("compute_limit_instruction");
  }
  if (accountsOf(0).length !== 0) reject("compute_limit_instruction");
  const computeUnits = readU32(limitData, 1);
  if (computeUnits > (expectation.maxComputeUnits ?? DEFAULT_MAX_COMPUTE_UNITS)) reject("compute_limit_too_high");

  // [1] SetComputeUnitPrice
  const priceData = dataOf(1);
  if (programOf(1) !== COMPUTE_BUDGET_PROGRAM || priceData.length !== 9 || priceData[0] !== SET_COMPUTE_UNIT_PRICE) {
    reject("compute_price_instruction");
  }
  if (accountsOf(1).length !== 0) reject("compute_price_instruction");
  const computeUnitPrice = readU64(priceData, 1);
  if (computeUnitPrice > (expectation.maxComputeUnitPriceMicroLamports ?? DEFAULT_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS)) {
    reject("compute_price_too_high");
  }

  // [2] TransferChecked on the original SPL Token program
  if (programOf(2) !== TOKEN_PROGRAM_ADDRESS) reject("transfer_program_not_spl_token");
  const transferData = dataOf(2);
  if (transferData.length !== 10 || transferData[0] !== TRANSFER_CHECKED) reject("not_transfer_checked");
  const transferAccounts = accountsOf(2);
  // Multisig authorities would append signer accounts; only a single-key authority is allowed.
  if (transferAccounts.length !== 4) reject("transfer_account_count");
  const [srcIdx, mintIdx, dstIdx, authIdx] = transferAccounts as [number, number, number, number];
  const source = keys[srcIdx];
  const mint = keys[mintIdx];
  const destination = keys[dstIdx];
  const authority = keys[authIdx];
  if (source === undefined || mint === undefined || destination === undefined || authority === undefined) {
    reject("transfer_account_index_out_of_range");
  }
  if (mint !== expectation.mint) reject("mint_mismatch", "WRONG_MINT");
  const decimals = transferData[9];
  if (decimals !== (expectation.decimals ?? DEMO_TOKEN_DECIMALS)) reject("decimals_mismatch", "WRONG_MINT");
  const amount = readU64(transferData, 1);
  if (amount !== expectation.amount) reject("amount_mismatch", "PRICE_CHANGED");
  if (destination !== expectation.merchantAta) reject("destination_not_merchant_ata");
  if (authority === feePayer) reject("fee_payer_is_transfer_authority");
  if (!signers.includes(authority) || authIdx >= numSignerAccounts) reject("authority_not_signer");
  if (expectation.payer !== undefined && authority !== expectation.payer) reject("authority_not_fresh_payer");
  const expectedSource = expectation.sourceAta ?? (await resolveSourceAta(authority, expectation.mint));
  if (source !== expectedSource) reject("source_not_payer_ata");
  if (!isWritable(srcIdx) || !isWritable(dstIdx)) reject("transfer_accounts_not_writable");
  if (source === destination) reject("self_transfer");

  // [3] optional memo, no accounts
  let memo: string | null = null;
  if (instructions.length === 4) {
    if (programOf(3) !== MEMO_PROGRAM) reject("unknown_instruction");
    if (accountsOf(3).length !== 0) reject("memo_has_accounts");
    const memoBytes = dataOf(3);
    if (memoBytes.length === 0 || memoBytes.length > 256) reject("memo_length");
    memo = new TextDecoder("utf-8", { fatal: true }).decode(memoBytes);
    if (expectation.memo !== undefined ? memo !== expectation.memo : !NONCE_MEMO.test(memo)) {
      reject("memo_not_allowed");
    }
  } else if (expectation.memo !== undefined) {
    reject("memo_missing");
  }

  // Fee payer isolation: it must not appear in any instruction (cannot be drained or delegated).
  for (let i = 0; i < instructions.length; i += 1) {
    for (const idx of accountsOf(i)) if (keys[idx] === feePayer) reject("fee_payer_referenced_by_instruction");
  }
  // Every non-program static account must be used by the transfer, apart from signers.
  const programIndexes = new Set(instructions.map((ix) => ix.programAddressIndex));
  for (let i = 0; i < keys.length; i += 1) {
    if (i === 0 || programIndexes.has(i) || transferAccounts.includes(i)) continue;
    reject("unexpected_account");
  }

  const recentBlockhash = compiled.lifetimeToken;
  if (expectation.recentBlockhash !== undefined && recentBlockhash !== expectation.recentBlockhash) {
    reject("blockhash_mismatch");
  }

  const sigKeys = Object.keys(transaction.signatures);
  if (sigKeys.length !== 2 || !sigKeys.includes(feePayer as string) || !sigKeys.includes(authority as string)) {
    reject("signature_slots_mismatch");
  }
  if (expectation.requirePayerSignature) {
    const sig = transaction.signatures[authority as Address];
    if (!sig) reject("payer_signature_missing");
    const key = await getPublicKeyFromAddress(authority as Address);
    if (!(await verifySignature(key, sig as SignatureBytes, messageBytes))) reject("payer_signature_invalid");
  }

  return {
    payer: authority as Address,
    feePayer: feePayer as Address,
    source: source as Address,
    destination: destination as Address,
    mint: mint as Address,
    amount,
    decimals,
    computeUnits,
    computeUnitPriceMicroLamports: computeUnitPrice,
    memo,
    recentBlockhash,
    messageHash: messageHashOf(messageBytes),
    messageBytes,
  };
}
