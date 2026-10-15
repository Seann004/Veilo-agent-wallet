"use client";

import { getBase58Decoder } from "@solana/kit";
import { SolanaSignAndSendTransaction, SolanaSignMessage, type SolanaSignAndSendTransactionFeature, type SolanaSignMessageFeature } from "@solana/wallet-standard-features";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { StandardConnect, type StandardConnectFeature } from "@wallet-standard/features";

/** Wallet Standard chain identifier for Solana devnet. Mainnet is never requested. */
export const DEVNET_CHAIN = "solana:devnet" as const;

export interface OwnerWallet {
  name: string;
  icon: string;
  wallet: Wallet;
}

/** Wallets that can connect and sign messages on devnet (Phantom and other Wallet Standard wallets). */
export function listWallets(): OwnerWallet[] {
  return getWallets()
    .get()
    .filter((w) => StandardConnect in w.features && SolanaSignMessage in w.features && w.chains.includes(DEVNET_CHAIN))
    .map((w) => ({ name: w.name, icon: w.icon, wallet: w }));
}

export function onWalletsChanged(cb: () => void): () => void {
  const api = getWallets();
  const off1 = api.on("register", cb);
  const off2 = api.on("unregister", cb);
  return () => {
    off1();
    off2();
  };
}

export async function connect(w: Wallet): Promise<WalletAccount> {
  const feature = (w.features as StandardConnectFeature)[StandardConnect];
  const { accounts } = await feature.connect();
  const account = accounts.find((a) => a.chains.includes(DEVNET_CHAIN)) ?? accounts[0];
  if (!account) throw new Error("the wallet returned no account");
  return account;
}

/** Signs the exact challenge text; the wallet shows it to the owner. No transaction is signed. */
export async function signChallenge(w: Wallet, account: WalletAccount, message: string): Promise<string> {
  const feature = (w.features as SolanaSignMessageFeature)[SolanaSignMessage];
  const [out] = await feature.signMessage({ account, message: new TextEncoder().encode(message) });
  if (!out) throw new Error("the wallet returned no signature");
  return getBase58Decoder().decode(out.signature);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Owner signs and sends a wallet-service-prepared devnet transaction (deposit or public exit). */
export async function signAndSend(w: Wallet, account: WalletAccount, transactionBase64: string): Promise<string> {
  const feature = (w.features as Partial<SolanaSignAndSendTransactionFeature>)[SolanaSignAndSendTransaction];
  if (!feature) throw new Error("this wallet cannot sign and send transactions");
  const [out] = await feature.signAndSendTransaction({ account, chain: DEVNET_CHAIN, transaction: base64ToBytes(transactionBase64) });
  if (!out) throw new Error("the wallet returned no transaction signature");
  return getBase58Decoder().decode(out.signature);
}
