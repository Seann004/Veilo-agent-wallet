"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { StandardDisconnect, type StandardDisconnectFeature } from "@wallet-standard/features";
import { ApiError, health as fetchHealth } from "../../lib/api";
import { marketApi, marketConfig, supabase } from "../../lib/market/client";
import { SIGN_IN_STATEMENT } from "../../lib/market/messages";
import type { MarketHealth, MeResponse } from "../../lib/market/types";
import type { Health } from "../../lib/types";
import { connect, onAccountChange, web3SignInAdapter, type OwnerWallet } from "../../lib/wallet";

export interface TokenInfo {
  network: string;
  mint: string;
  /** Known only when the local control service has verified the same mint on chain. */
  decimals: number | null;
}

export interface MarketContextValue {
  configured: boolean;
  /** Ready means the stored session has been checked; before that, nothing is shown as signed out. */
  ready: boolean;
  me: MeResponse | null;
  meError: ApiError | undefined;
  reloadMe: () => Promise<void>;
  wallet: { wallet: Wallet; account: WalletAccount } | null;
  /** Address the connected wallet switched to while the session belongs to another address. */
  mismatch: string | null;
  /** Signed in, identity loaded and no wallet mismatch: identity-sensitive actions may run. */
  canAct: boolean;
  token: TokenInfo | null;
  tokenError: ApiError | undefined;
  signIn: (w: OwnerWallet) => Promise<void>;
  signOut: () => Promise<void>;
  disconnectWallet: () => Promise<void>;
  connectWallet: (w: OwnerWallet) => Promise<void>;
  /** Calls the marketplace with the current session's bearer token. */
  call: <T>(path: string, init?: { method?: "GET" | "POST"; body?: unknown }) => Promise<T>;
  accessToken: () => Promise<string | null>;
}

const MarketContext = createContext<MarketContextValue | null>(null);

export function useMarket(): MarketContextValue {
  const v = useContext(MarketContext);
  if (!v) throw new Error("useMarket must be used inside the marketplace provider");
  return v;
}

/** Test helper: provides a fixed marketplace context. */
export function MarketContextProvider({ value, children }: { value: MarketContextValue; children: ReactNode }) {
  return <MarketContext.Provider value={value}>{children}</MarketContext.Provider>;
}

const asApiError = (e: unknown): ApiError => (e instanceof ApiError ? e : new ApiError(0, "INTERNAL_ERROR", (e as Error)?.message ?? "unexpected error"));

/**
 * Marketplace identity: a Supabase Web3 session, used only as a bearer token for the marketplace
 * API. It is independent of the local owner session that holds spending authority.
 */
export function MarketProvider({ children }: { children: ReactNode }) {
  const configured = marketConfig() !== null;
  const [ready, setReady] = useState(!configured);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [meError, setMeError] = useState<ApiError>();
  const [wallet, setWallet] = useState<{ wallet: Wallet; account: WalletAccount } | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [token, setToken] = useState<TokenInfo | null>(null);
  const [tokenError, setTokenError] = useState<ApiError>();
  const meRef = useRef<MeResponse | null>(null);
  meRef.current = me;

  const accessToken = useCallback(async (): Promise<string | null> => {
    if (!configured) return null;
    const { data } = await supabase().auth.getSession();
    return data.session?.access_token ?? null;
  }, [configured]);

  const call = useCallback(
    async <T,>(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> => {
      const t = await accessToken();
      if (!t) throw new ApiError(401, "UNAUTHENTICATED", "sign in to the marketplace with your wallet first");
      return marketApi<T>(path, { ...init, token: t });
    },
    [accessToken],
  );

  const loadMe = useCallback(async () => {
    const t = await accessToken();
    if (!t) {
      setMe(null);
      setMeError(undefined);
      return;
    }
    try {
      setMe(await marketApi<MeResponse>("/me", { token: t }));
      setMeError(undefined);
    } catch (e) {
      setMeError(asApiError(e));
    }
  }, [accessToken]);

  useEffect(() => {
    if (!configured) return;
    let live = true;
    void loadMe().finally(() => live && setReady(true));
    const { data } = supabase().auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        setMe(null);
        setMeError(undefined);
      }
    });
    return () => {
      live = false;
      data.subscription.unsubscribe();
    };
  }, [configured, loadMe]);

  useEffect(() => {
    if (!configured) return;
    let live = true;
    (async () => {
      try {
        const market = await marketApi<MarketHealth>("/health");
        let decimals: number | null = null;
        try {
          const control = await fetchHealth<Health>("control");
          if (control.chain.state === "verified" && control.chain.identity.mint === market.mint && control.chain.identity.caip2 === market.network) {
            decimals = control.chain.identity.mintDecimals;
          }
        } catch {
          decimals = null;
        }
        if (decimals === null) {
          // Published listings carry the decimals the marketplace itself was configured with.
          const { listings } = await marketApi<{ listings: Array<{ mint: string; network: string; decimals: number }> }>("/marketplace/listings?limit=1").catch(() => ({ listings: [] }));
          const same = listings.find((l) => l.mint === market.mint && l.network === market.network);
          if (same && Number.isInteger(same.decimals)) decimals = same.decimals;
        }
        if (live) {
          setToken({ network: market.network, mint: market.mint, decimals });
          setTokenError(undefined);
        }
      } catch (e) {
        if (live) setTokenError(asApiError(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [configured]);

  useEffect(() => {
    if (!wallet) return;
    return onAccountChange(wallet.wallet, (address) => {
      setWalletAddress(address);
      if (address === null) setWallet(null);
    });
  }, [wallet]);

  const signIn = useCallback(
    async (w: OwnerWallet) => {
      const account = await connect(w.wallet);
      const auth = supabase().auth;
      // A different address never inherits the current session.
      if (meRef.current && meRef.current.address !== account.address) await auth.signOut();
      const { error } = await auth.signInWithWeb3({ chain: "solana", statement: SIGN_IN_STATEMENT, wallet: web3SignInAdapter(w.wallet, account) });
      if (error) throw new ApiError(error.status ?? 401, "UNAUTHENTICATED", error.message);
      const t = await accessToken();
      if (!t) throw new ApiError(401, "UNAUTHENTICATED", "sign-in returned no session");
      await marketApi("/me/bootstrap", { method: "POST", token: t, body: {} });
      setWallet({ wallet: w.wallet, account });
      setWalletAddress(account.address);
      await loadMe();
    },
    [accessToken, loadMe],
  );

  const signOut = useCallback(async () => {
    if (configured) await supabase().auth.signOut();
    setMe(null);
    setMeError(undefined);
  }, [configured]);

  const connectWallet = useCallback(async (w: OwnerWallet) => {
    const account = await connect(w.wallet);
    setWallet({ wallet: w.wallet, account });
    setWalletAddress(account.address);
  }, []);

  const disconnectWallet = useCallback(async () => {
    const feature = wallet ? (wallet.wallet.features as Partial<StandardDisconnectFeature>)[StandardDisconnect] : undefined;
    setWallet(null);
    setWalletAddress(null);
    if (feature) await feature.disconnect().catch(() => undefined);
  }, [wallet]);

  const mismatch = me && walletAddress && walletAddress !== me.address ? walletAddress : null;

  const value = useMemo<MarketContextValue>(
    () => ({
      configured,
      ready,
      me,
      meError,
      reloadMe: loadMe,
      wallet: wallet && walletAddress === wallet.account.address ? wallet : null,
      mismatch,
      canAct: me !== null && mismatch === null,
      token,
      tokenError,
      signIn,
      signOut,
      disconnectWallet,
      connectWallet,
      call,
      accessToken,
    }),
    [configured, ready, me, meError, loadMe, wallet, walletAddress, mismatch, token, tokenError, signIn, signOut, disconnectWallet, connectWallet, call, accessToken],
  );
  return <MarketContext.Provider value={value}>{children}</MarketContext.Provider>;
}
