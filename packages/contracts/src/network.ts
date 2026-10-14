export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const MAINNET_CAIP2_FULL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc";

export const DEMO_TOKEN_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const DEMO_TOKEN_DECIMALS = 6;

// Original SPL Token program; Token-2022 mints are rejected.
export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const MAINNET_IDENTIFIERS = new Set([MAINNET_GENESIS_HASH, MAINNET_CAIP2_FULL, MAINNET_CAIP2]);

export function isMainnetIdentifier(value: string): boolean {
  const trimmed = value.trim();
  if (MAINNET_IDENTIFIERS.has(trimmed)) return true;
  // CAIP-2 references are genesis-hash prefixes, so any prefix of mainnet's hash is mainnet.
  const reference = trimmed.startsWith("solana:") ? trimmed.slice("solana:".length) : trimmed;
  return reference.length >= 8 && MAINNET_GENESIS_HASH.startsWith(reference);
}
