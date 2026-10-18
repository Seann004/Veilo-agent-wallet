"use client";

import { getBase58Decoder } from "@solana/kit";
import { ApiError } from "./api";
import {
  SolanaSignAndSendTransaction,
  SolanaSignIn,
  SolanaSignMessage,
  type SolanaSignAndSendTransactionFeature,
  type SolanaSignInFeature,
  type SolanaSignInInput,
  type SolanaSignInOutput,
  type SolanaSignMessageFeature,
} from "@solana/wallet-standard-features";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { StandardConnect, StandardEvents, type StandardConnectFeature, type StandardEventsFeature } from "@wallet-standard/features";

/** Wallet Standard chain identifier for Solana devnet. Mainnet is never requested. */
export const DEVNET_CHAIN = "solana:devnet" as const;

export interface OwnerWallet {
  name: string;
  icon: string;
  wallet: Wallet;
}

const LAST_WALLET_KEY = "veilo.ownerWallet";

/** Remembers which wallet the owner connected, so a reload can reconnect it silently. */
export function rememberWallet(name: string | null): void {
  try {
    if (name) localStorage.setItem(LAST_WALLET_KEY, name);
    else localStorage.removeItem(LAST_WALLET_KEY);
  } catch {
    // Storage can be unavailable (private windows); the owner just connects by hand.
  }
}

export function lastWallet(): string | null {
  try {
    return localStorage.getItem(LAST_WALLET_KEY);
  } catch {
    return null;
  }
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

/** With `silent`, the wallet reconnects only if this site was approved before and never prompts. */
export async function connect(w: Wallet, silent = false): Promise<WalletAccount> {
  const feature = (w.features as StandardConnectFeature)[StandardConnect];
  const { accounts } = await feature.connect(silent ? { silent: true } : undefined);
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

/** Raw signature bytes over the exact message; the wallet displays the text to the owner. */
export async function signMessageBytes(w: Wallet, account: WalletAccount, message: Uint8Array): Promise<Uint8Array> {
  const feature = (w.features as SolanaSignMessageFeature)[SolanaSignMessage];
  const [out] = await feature.signMessage({ account, message });
  if (!out) throw new Error("the wallet returned no signature");
  return out.signature;
}

interface SignInResult {
  account: { address: string; publicKey: Uint8Array; chains: SolanaSignInOutput["account"]["chains"]; features: SolanaSignInOutput["account"]["features"] };
  signedMessage: Uint8Array;
  signature: Uint8Array;
}

export interface Web3SignInWallet {
  publicKey: { toBase58: () => string };
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  signIn?: (input: SolanaSignInInput) => Promise<SignInResult>;
}

/**
 * Adapter for Supabase Web3 sign-in: exposes only the public key, message signing and Sign In
 * With Solana. It can sign a login message; it has no way to sign or send a transaction.
 * Wallets that implement solana:signIn build the login message themselves; Phantom rejects a
 * Sign In With Solana message passed to plain signMessage as invalid formatting.
 */
export function web3SignInAdapter(w: Wallet, account: WalletAccount): Web3SignInWallet {
  const signIn = (w.features as Partial<SolanaSignInFeature>)[SolanaSignIn];
  return {
    publicKey: { toBase58: () => account.address },
    signMessage: (message: Uint8Array) => signMessageBytes(w, account, message),
    ...(signIn
      ? {
          signIn: async (input: SolanaSignInInput): Promise<SignInResult> => {
            const [out] = await signIn.signIn({ ...input, address: account.address });
            if (!out) throw new Error("the wallet returned no sign-in");
            // The session belongs to whichever account signed, so it must be the connected one.
            if (out.account.address !== account.address) throw new Error("the wallet signed in with a different account");
            return {
              account: { address: out.account.address, publicKey: new Uint8Array(out.account.publicKey), chains: out.account.chains, features: out.account.features },
              signedMessage: new Uint8Array(out.signedMessage),
              signature: new Uint8Array(out.signature),
            };
          },
        }
      : {}),
  };
}

/**
 * Reports the wallet's current devnet account whenever it changes (null when disconnected).
 * Wallets without the standard events feature never report a change.
 */
export function onAccountChange(w: Wallet, cb: (address: string | null) => void): () => void {
  const events = (w.features as Partial<StandardEventsFeature>)[StandardEvents];
  if (!events) return () => undefined;
  return events.on("change", (props) => {
    if (!props.accounts) return;
    const account = props.accounts.find((a) => a.chains.includes(DEVNET_CHAIN)) ?? props.accounts[0];
    cb(account?.address ?? null);
  });
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
  let out;
  try {
    [out] = await feature.signAndSendTransaction({ account, chain: DEVNET_CHAIN, transaction: base64ToBytes(transactionBase64) });
  } catch (e) {
    // A wallet refusal or failed pre-send check is the wallet's answer, not an unreachable server.
    throw new ApiError(0, "WALLET_ERROR", (e as Error)?.message || "the wallet did not sign or send the transaction");
  }
  if (!out) throw new Error("the wallet returned no transaction signature");
  return getBase58Decoder().decode(out.signature);
}
