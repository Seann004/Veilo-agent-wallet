use anchor_lang::prelude::*;

/// Codes start at 6000 in this order; off-chain services depend on the numbering.
#[error_code]
pub enum PoolError {
    #[msg("field element is not canonical (32-byte big-endian below r)")]
    NonCanonicalFieldElement,
    #[msg("zero value not allowed")]
    ZeroValueNotAllowed,
    #[msg("derived label is zero")]
    ZeroLabel,
    #[msg("commitment is zero")]
    ZeroCommitment,
    #[msg("genesis hash not allowed for this build")]
    InvalidGenesis,
    #[msg("mint does not match the pinned mint or is not an initialized SPL Token mint")]
    InvalidMint,
    #[msg("token program must be the original SPL Token program")]
    InvalidTokenProgram,
    #[msg("invalid token account")]
    InvalidTokenAccount,
    #[msg("vault does not match the pool or has an unexpected owner, delegate or close authority")]
    InvalidVault,
    #[msg("invalid destination token account")]
    InvalidDestination,
    #[msg("account belongs to another pool")]
    PoolMismatch,
    #[msg("signer is not authorized")]
    Unauthorized,
    #[msg("signer is not the program upgrade authority")]
    NotUpgradeAuthority,
    #[msg("deposits are paused")]
    DepositsPaused,
    #[msg("deposit below minimum")]
    DepositBelowMinimum,
    #[msg("deposit above maximum")]
    DepositAboveMaximum,
    #[msg("pool liability cap exceeded")]
    LiabilityCapExceeded,
    #[msg("tree capacity exhausted")]
    TreeCapacityExhausted,
    #[msg("insertion queue is full")]
    QueueFull,
    #[msg("vault did not receive the exact amount")]
    TransferAmountMismatch,
    #[msg("deposit is not pending")]
    DepositNotPending,
    #[msg("exactly one queue record is required")]
    InvalidQueueItem,
    #[msg("record is not the queue head")]
    NotQueueHead,
    #[msg("queue record is not pending")]
    QueueItemNotPending,
    #[msg("queue record is not refunded")]
    QueueItemNotRefunded,
    #[msg("state root is not in the root history")]
    UnknownStateRoot,
    #[msg("proof verification failed")]
    InvalidProof,
    #[msg("payout must be positive")]
    PayoutZero,
    #[msg("amount overflow")]
    AmountOverflow,
    #[msg("relayer signer does not match the intent")]
    RelayerMismatch,
    #[msg("relayer fee not allowed")]
    RelayerFeeNotAllowed,
    #[msg("relayer fee account does not match the intent")]
    RelayerFeeAccountMismatch,
    #[msg("intent expired")]
    IntentExpired,
    #[msg("intent expiry is more than 750 slots ahead")]
    IntentTooFarInFuture,
    #[msg("liability underflow")]
    LiabilityUnderflow,
    #[msg("configuration value out of bounds")]
    ConfigOutOfBounds,
}
