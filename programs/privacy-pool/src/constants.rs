use anchor_lang::prelude::*;

#[cfg(all(feature = "devnet", feature = "localnet"))]
compile_error!("enable exactly one of the `devnet` and `localnet` features");
#[cfg(not(any(feature = "devnet", feature = "localnet")))]
compile_error!("enable exactly one of the `devnet` and `localnet` features");

pub const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ASSOCIATED_TOKEN_PROGRAM_ID: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

#[constant]
pub const POOL_SEED: &[u8] = b"pool";
#[constant]
pub const VAULT_AUTHORITY_SEED: &[u8] = b"vault_authority";
#[constant]
pub const DEPOSIT_SEED: &[u8] = b"deposit";
#[constant]
pub const PRECOMMITMENT_SEED: &[u8] = b"precommitment";
#[constant]
pub const CHANGE_SEED: &[u8] = b"change";
#[constant]
pub const NULLIFIER_SEED: &[u8] = b"nullifier";
#[constant]
pub const APPROVAL_SEED: &[u8] = b"approval";

#[constant]
pub const PROTOCOL_VERSION: u8 = 1;
#[constant]
pub const TREE_CAPACITY: u64 = 65_536;
#[constant]
pub const CHANGE_RESERVE: u64 = 1_024;
#[constant]
pub const ROOT_HISTORY: u8 = 32;
#[constant]
pub const QUEUE_MAX_LIVE_DEPOSITS: u64 = 64;
#[constant]
pub const MAX_INTENT_SLOTS: u64 = 750;
#[constant]
pub const HARD_MAX_DEPOSIT: u64 = 20_000_000;
#[constant]
pub const HARD_LIABILITY_CAP: u64 = 100_000_000;
#[constant]
pub const HARD_MAX_RELAYER_FEE: u64 = 100_000;

pub const DEFAULT_MIN_DEPOSIT: u64 = 100_000;
pub const DEFAULT_MAX_DEPOSIT: u64 = 20_000_000;
pub const DEFAULT_LIABILITY_CAP: u64 = 100_000_000;
pub const DEFAULT_MAX_RELAYER_FEE: u64 = 0;

/// EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG
pub const DEVNET_GENESIS: [u8; 32] = [
    0xce, 0x59, 0xdb, 0x50, 0x80, 0xfc, 0x2c, 0x6d, 0x3b, 0xcf, 0x7c, 0xa9, 0x07, 0x12, 0xd3, 0xc2,
    0xe5, 0xe6, 0xc2, 0x8f, 0x27, 0xf0, 0xdf, 0xbb, 0x99, 0x53, 0xbd, 0xb0, 0x89, 0x4c, 0x03, 0xab,
];

/// 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d (mainnet-beta), rejected by every build.
pub const MAINNET_GENESIS: [u8; 32] = [
    0x45, 0x29, 0x69, 0x98, 0xa6, 0xf8, 0xe2, 0xa7, 0x84, 0xdb, 0x5d, 0x9f, 0x95, 0xe1, 0x8f, 0xc2,
    0x3f, 0x70, 0x44, 0x1a, 0x10, 0x39, 0x44, 0x68, 0x01, 0x08, 0x98, 0x79, 0xb0, 0x8c, 0x7e, 0xf0,
];

/// Whether `initialize_pool` may pin this genesis hash. The program cannot read the cluster's
/// genesis hash, so this is a build-time binding checked against the supplied value.
pub fn genesis_allowed(genesis: &[u8; 32]) -> bool {
    if *genesis == MAINNET_GENESIS || *genesis == [0u8; 32] {
        return false;
    }
    #[cfg(feature = "devnet")]
    {
        *genesis == DEVNET_GENESIS
    }
    #[cfg(not(feature = "devnet"))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mainnet_and_zero_genesis_always_rejected() {
        assert!(!genesis_allowed(&MAINNET_GENESIS));
        assert!(!genesis_allowed(&[0u8; 32]));
        assert!(genesis_allowed(&DEVNET_GENESIS));
    }

    #[cfg(feature = "devnet")]
    #[test]
    fn devnet_build_pins_devnet_genesis() {
        let mut other = DEVNET_GENESIS;
        other[31] ^= 1;
        assert!(!genesis_allowed(&other));
    }

    #[test]
    fn tree_constants_match_crypto_crate() {
        assert_eq!(TREE_CAPACITY, veilo_crypto::TREE_CAPACITY);
        assert_eq!(MAX_INTENT_SLOTS, veilo_crypto::MAX_INTENT_SLOTS);
        assert_eq!(PROTOCOL_VERSION, veilo_crypto::PROTOCOL_VERSION);
    }
}
