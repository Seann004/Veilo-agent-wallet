import { isDeepStrictEqual } from "node:util";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired, SettleResponse } from "@x402/core/types";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { DEVNET_CAIP2 } from "@veilo/contracts";
import { deriveAta } from "./ata";
import { verifyPaymentRequired, type ApprovedServiceBinding } from "./binding";
import { X402ClientError } from "./errors";
import { createConstrainedPaymentSigner, type FreshPaymentWallet } from "./signer";
import { validateExactPaymentTransaction, type ValidatedPayment } from "./validate-transaction";

export interface PreparePaymentOptions {
  paymentRequired: PaymentRequired;
  binding: ApprovedServiceBinding;
  wallet: FreshPaymentWallet;
  purchaseRef: string;
  /** Devnet RPC used by the SDK for mint metadata and (if not supplied in the challenge) a blockhash. */
  rpcUrl: string;
}

export interface PreparedPayment {
  paymentPayload: PaymentPayload;
  /** Protocol-encoded headers (PAYMENT-SIGNATURE) produced by the SDK encoder. */
  headers: Record<string, string>;
  validated: ValidatedPayment;
}

/**
 * Builds exactly one signed payment for an approved binding. The SDK constructs the
 * transaction; the constrained signer validates it before the wallet signs, and the final
 * payload is validated again (including the payer signature) before it is returned.
 */
export async function preparePayment(options: PreparePaymentOptions): Promise<PreparedPayment> {
  const { binding, wallet } = options;
  const verified = await verifyPaymentRequired(options.paymentRequired, binding);
  const expectation = {
    network: binding.network,
    mint: binding.mint,
    amount: verified.amount,
    payTo: binding.payTo,
    merchantAta: binding.merchantAta,
    feePayers: [verified.feePayer],
    ...(verified.recentBlockhash !== undefined ? { recentBlockhash: verified.recentBlockhash } : {}),
  };
  const signer = createConstrainedPaymentSigner(wallet, expectation, options.purchaseRef);

  const client = new x402Client((_v, reqs) => {
    if (reqs.length !== 1) throw new X402ClientError("SERVICE_NOT_ALLOWED", "selector_expected_single_requirement");
    return reqs[0] as (typeof reqs)[number];
  });
  client.register(DEVNET_CAIP2, new ExactSvmScheme(signer, { rpcUrl: options.rpcUrl }));
  client.setSpendControls({
    maxAmountPerPayment: false,
    allowedAssets: [{ network: DEVNET_CAIP2, asset: binding.mint, maxAmountPerPayment: binding.maxAmount.toString() }],
  });
  client.registerPolicy((_v, reqs) => reqs.filter((r) => isDeepStrictEqual(r, verified.requirements)));

  const paymentPayload = await client.createPaymentPayload({
    ...options.paymentRequired,
    accepts: [verified.requirements],
  });
  if (!signer.used) throw new X402ClientError("POLICY_DENIED", "payment_not_signed_by_constrained_signer");
  if (paymentPayload.x402Version !== 2 || !isDeepStrictEqual(paymentPayload.accepted, verified.requirements)) {
    throw new X402ClientError("POLICY_DENIED", "payload_accepted_mismatch");
  }
  const transaction = paymentPayload.payload.transaction;
  if (typeof transaction !== "string") throw new X402ClientError("POLICY_DENIED", "payload_without_transaction");
  const validated = await validateExactPaymentTransaction(
    transaction,
    { ...expectation, payer: wallet.address, requirePayerSignature: true },
    deriveAta,
  );
  if (signer.validated?.messageHash !== validated.messageHash) {
    throw new X402ClientError("POLICY_DENIED", "signed_message_changed");
  }
  const headers = new x402HTTPClient(client).encodePaymentSignatureHeader(paymentPayload);
  return { paymentPayload, headers, validated };
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface PayOnceOptions {
  url: string;
  init?: RequestInit;
  binding: ApprovedServiceBinding;
  wallet: FreshPaymentWallet;
  purchaseRef: string;
  rpcUrl: string;
  fetchImpl?: FetchLike;
}

export interface PayOnceResult {
  status: number;
  paid: boolean;
  settleResponse: SettleResponse | undefined;
  body: unknown;
  validated: ValidatedPayment | undefined;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * One explicit paid request: unpaid request, challenge verification, a single signed
 * payment and a single paid request. There is no automatic retry loop; any failure after
 * the payment header is sent is returned to the caller for reconciliation.
 */
export async function payOnce(options: PayOnceOptions): Promise<PayOnceResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const first = await fetchImpl(options.url, { ...options.init, redirect: "error" });
  if (first.status !== 402) {
    return { status: first.status, paid: false, settleResponse: undefined, body: await readBody(first), validated: undefined };
  }
  const httpClient = new x402HTTPClient(new x402Client());
  const body = await readBody(first);
  const paymentRequired = httpClient.getPaymentRequiredResponse((name) => first.headers.get(name), body);
  const prepared = await preparePayment({
    paymentRequired,
    binding: options.binding,
    wallet: options.wallet,
    purchaseRef: options.purchaseRef,
    rpcUrl: options.rpcUrl,
  });
  const headers = new Headers(options.init?.headers);
  for (const [name, value] of Object.entries(prepared.headers)) headers.set(name, value);
  const second = await fetchImpl(options.url, { ...options.init, headers, redirect: "error" });
  let settleResponse: SettleResponse | undefined;
  try {
    settleResponse = httpClient.getPaymentSettleResponse((name) => second.headers.get(name));
  } catch {
    settleResponse = undefined;
  }
  return {
    status: second.status,
    paid: second.ok && settleResponse?.success === true,
    settleResponse,
    body: await readBody(second),
    validated: prepared.validated,
  };
}
