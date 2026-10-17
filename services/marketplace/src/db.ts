import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import type { MarketplaceConfig } from "./config";
import { fromDbError, MarketError } from "./errors";

/**
 * Two kinds of client: the server-role client calls transition functions after the API has
 * authenticated the actor; user-scoped clients carry the caller's JWT so reads stay under RLS.
 */
export interface Db {
  admin: SupabaseClient;
  asUser(accessToken: string): SupabaseClient;
  anon(): SupabaseClient;
  /** Validates an access token with the Auth server, so revoked sessions are refused. */
  getUser(accessToken: string): Promise<User | null>;
  rpc<T>(fn: string, args: Record<string, unknown>): Promise<T>;
}

const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } } as const;

export function createDb(config: MarketplaceConfig): Db {
  const admin = createClient(config.supabaseUrl, config.supabaseSecretKey, noSession);
  return {
    admin,
    asUser(accessToken) {
      return createClient(config.supabaseUrl, config.supabasePublishableKey, {
        ...noSession,
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      });
    },
    anon() {
      return createClient(config.supabaseUrl, config.supabasePublishableKey, noSession);
    },
    async getUser(accessToken) {
      const { data, error } = await admin.auth.getUser(accessToken);
      if (error || !data.user) return null;
      return data.user;
    },
    async rpc<T>(fn: string, args: Record<string, unknown>) {
      const { data, error } = await admin.rpc(fn, args);
      const mapped = fromDbError(error);
      if (mapped) throw mapped;
      return data as T;
    },
  };
}

export function must<T>(result: { data: T | null; error: { message?: string } | null }, notFound = "not found"): T {
  const mapped = fromDbError(result.error);
  if (mapped) throw mapped;
  if (result.data === null) throw new MarketError("NOT_FOUND", notFound);
  return result.data;
}
