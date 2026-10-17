import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "../api";

export interface MarketConfig {
  supabaseUrl: string;
  supabaseKey: string;
  marketplaceUrl: string;
}

/** Reads the public marketplace configuration; null when any value is missing or malformed. */
export function marketConfig(
  env: Record<string, string | undefined> = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_MARKETPLACE_URL: process.env.NEXT_PUBLIC_MARKETPLACE_URL,
  },
): MarketConfig | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  const market = env.NEXT_PUBLIC_MARKETPLACE_URL?.trim();
  if (!url || !key || !market) return null;
  try {
    return { supabaseUrl: new URL(url).origin, supabaseKey: key, marketplaceUrl: new URL(market).origin };
  } catch {
    return null;
  }
}

let client: SupabaseClient | null = null;

/** Browser Supabase client used only for Web3 sign-in and RLS-scoped reads. */
export function supabase(): SupabaseClient {
  const cfg = marketConfig();
  if (!cfg) throw new ApiError(0, "NOT_READY", "the marketplace is not configured (NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, NEXT_PUBLIC_MARKETPLACE_URL)");
  client ??= createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: "veilo-marketplace-auth" },
  });
  return client;
}

/**
 * Calls the marketplace API. Authentication is a bearer access token only; no cookies are sent,
 * so a cross-site page cannot ride on the session.
 */
export async function marketApi<T = unknown>(path: string, init: { method?: "GET" | "POST"; body?: unknown; token?: string | null } = {}): Promise<T> {
  const cfg = marketConfig();
  if (!cfg) throw new ApiError(0, "NOT_READY", "the marketplace is not configured (NEXT_PUBLIC_MARKETPLACE_URL)");
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (method !== "GET") headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${cfg.marketplaceUrl}${path}`, {
      method,
      headers,
      credentials: "omit",
      cache: "no-store",
      ...(method !== "GET" ? { body: JSON.stringify(init.body ?? {}) } : {}),
    });
  } catch {
    throw new ApiError(0, "NOT_READY", "the marketplace service is not reachable");
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const e = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? (res.status >= 502 ? "NOT_READY" : "INTERNAL_ERROR"), e?.message ?? `marketplace request failed with status ${res.status}`);
  }
  return body as T;
}

/** Only follows download links that point at the configured Supabase Storage origin. */
export function trustedDownloadUrl(url: string, cfg: MarketConfig | null = marketConfig()): string | null {
  if (!cfg) return null;
  try {
    const u = new URL(url);
    return u.origin === cfg.supabaseUrl && u.pathname.startsWith("/storage/v1/") ? u.toString() : null;
  } catch {
    return null;
  }
}
