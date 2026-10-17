import { isAddress } from "@solana/kit";
import { VeiloConfigError } from "@veilo/contracts";
import { DEFAULT_GUEST_RUNS_PER_HOUR } from "./session";

/** Comma-separated base58 guest wallets. Startup fails on any invalid entry or on the owner key. */
export function parseGuestPubkeys(raw: string | undefined, ownerPubkey: string | undefined): string[] {
  const entries = (raw ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "");
  for (const entry of entries) {
    if (!isAddress(entry)) throw new VeiloConfigError("INVALID_CONFIG", "VEILO_GUEST_PUBKEYS: every entry must be a base58 Solana address");
    if (ownerPubkey !== undefined && entry === ownerPubkey) {
      throw new VeiloConfigError("INVALID_CONFIG", "VEILO_GUEST_PUBKEYS: must not contain the workspace owner key");
    }
  }
  return [...new Set(entries)];
}

/** Only the exact value "1" enables the anonymous read-only view. */
export function parsePublicView(raw: string | undefined): boolean {
  const v = raw?.trim() ?? "";
  if (v === "" || v === "0") return false;
  if (v === "1") return true;
  throw new VeiloConfigError("INVALID_CONFIG", "VEILO_PUBLIC_VIEW: must be 1 or 0");
}

export function parseGuestRunsPerHour(raw: string | undefined): number {
  const v = raw?.trim() ?? "";
  if (v === "") return DEFAULT_GUEST_RUNS_PER_HOUR;
  const n = Number(v);
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(n) || n < 1 || n > 10_000) {
    throw new VeiloConfigError("INVALID_CONFIG", "VEILO_GUEST_RUNS_PER_HOUR: must be an integer from 1 to 10000");
  }
  return n;
}
