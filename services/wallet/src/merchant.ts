import type { SignatureBytes } from "@solana/kit";
import type { PaymentRequired } from "@x402/core/types";
import { createDevnetRpc } from "@veilo/contracts";
import { preparePayment, type ApprovedServiceBinding } from "@veilo/x402-client";
import type { MerchantSigner } from "./deps";
import { WalletError } from "./errors";

/**
 * Production merchant signer: @veilo/x402-client validates the challenge against the approved
 * binding and the complete transaction before the fresh wallet signs exactly once.
 */
export function x402MerchantSigner(rpcUrl: string): MerchantSigner {
  // The mint read goes through the shared 429-aware client; the challenge carries the blockhash.
  // Retries stay well inside control's 120 s call timeout; control retries a not_ready later.
  const rpc = createDevnetRpc(rpcUrl, { maxRetries: 4, maxDelayMs: 8_000 });
  return {
    async sign({ paymentRequired, binding, exactAmount, purchaseRef, wallet }) {
      const approved: ApprovedServiceBinding = {
        origin: binding.origin,
        gatewayIdentity: binding.gatewayIdentity,
        sku: binding.sku,
        network: binding.network,
        mint: binding.mint,
        payTo: binding.payTo,
        merchantAta: binding.merchantAta,
        maxAmount: exactAmount,
        exactAmount,
        allowedFeePayers: binding.allowedFeePayers,
      };
      const prepared = await preparePayment({
        paymentRequired: paymentRequired as PaymentRequired,
        binding: approved,
        wallet: { address: wallet.address, signPaymentMessage: async (r) => (await wallet.signPaymentMessage(r)) as SignatureBytes },
        purchaseRef,
        rpcUrl,
        rpc,
      });
      const header = Object.values(prepared.headers)[0];
      if (header === undefined) throw new WalletError("POLICY_DENIED", "x402 client produced no payment header");
      return { paymentSignatureHeader: header, messageHash: prepared.validated.messageHash, recentBlockhash: prepared.validated.recentBlockhash };
    },
  };
}
