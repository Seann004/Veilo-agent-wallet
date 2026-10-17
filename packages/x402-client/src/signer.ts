import {
  signBytes,
  type Address,
  type KeyPairSigner,
  type SignatureBytes,
  type SignatureDictionary,
  type TransactionPartialSigner,
} from "@solana/kit";
import { deriveAta } from "./ata";
import { X402ClientError } from "./errors";
import {
  validateExactPaymentTransaction,
  type ExactPaymentExpectation,
  type ValidatedPayment,
} from "./validate-transaction";

export interface PaymentSigningRequest {
  /** Caller's logical purchase reference; lets the wallet bind the key to one purchase. */
  purchaseRef: string;
  /** Exact message bytes to sign; already validated against the approved expectation. */
  messageBytes: Uint8Array;
  validated: ValidatedPayment;
}

/**
 * A fresh per-purchase payment wallet, implemented by the wallet service. It exposes no
 * general-purpose signTransaction: it signs only a message this adapter has validated, and
 * implementations must refuse a second signature for the same key.
 */
export interface FreshPaymentWallet {
  readonly address: Address;
  signPaymentMessage(request: PaymentSigningRequest): Promise<SignatureBytes>;
}

export interface ConstrainedPaymentSigner extends TransactionPartialSigner {
  /** True once the single permitted signature has been requested. */
  readonly used: boolean;
  /** The validation result of the signed message, once signed. */
  readonly validated: ValidatedPayment | undefined;
}

/**
 * Wraps a fresh wallet in a kit signer that validates the complete transaction before
 * signing and signs at most once. The payer in `expectation` is forced to the wallet.
 */
export function createConstrainedPaymentSigner(
  wallet: FreshPaymentWallet,
  expectation: Omit<ExactPaymentExpectation, "payer" | "requirePayerSignature">,
  purchaseRef: string,
): ConstrainedPaymentSigner {
  let used = false;
  let validated: ValidatedPayment | undefined;
  const signer: ConstrainedPaymentSigner = {
    address: wallet.address,
    get used() {
      return used;
    },
    get validated() {
      return validated;
    },
    async signTransactions(transactions): Promise<readonly SignatureDictionary[]> {
      if (transactions.length !== 1) throw new X402ClientError("POLICY_DENIED", "exactly_one_transaction_required");
      if (used) throw new X402ClientError("POLICY_DENIED", "payment_signer_already_used");
      used = true;
      const result = await validateExactPaymentTransaction(
        transactions[0] as (typeof transactions)[number],
        { ...expectation, payer: wallet.address, requirePayerSignature: false },
        deriveAta,
      );
      const signature = await wallet.signPaymentMessage({
        purchaseRef,
        messageBytes: result.messageBytes,
        validated: result,
      });
      validated = result;
      return [{ [wallet.address]: signature } as SignatureDictionary];
    },
  };
  return signer;
}

/**
 * Single-use wallet over a local key pair, for the explicit smoke script and tests.
 * Production fresh wallets come from the wallet service.
 */
export function keyPairPaymentWallet(signer: KeyPairSigner): FreshPaymentWallet {
  let signed = false;
  return {
    address: signer.address,
    async signPaymentMessage({ messageBytes }) {
      if (signed) throw new X402ClientError("POLICY_DENIED", "payment_wallet_already_used");
      signed = true;
      return signBytes(signer.keyPair.privateKey, messageBytes);
    },
  };
}
