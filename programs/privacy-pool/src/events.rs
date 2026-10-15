use anchor_lang::prelude::*;

#[event]
pub struct PoolInitialized {
    pub pool: Pubkey,
    pub pool_id: [u8; 32],
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub vault: Pubkey,
    pub genesis_hash: [u8; 32],
    pub empty_root: [u8; 32],
    pub config_authority: Pubkey,
    pub approval_authority: Pubkey,
    pub protocol_version: u8,
}

#[event]
pub struct DepositQueued {
    pub pool: Pubkey,
    pub queue_seq: u64,
    pub amount: u64,
    pub refund_authority: Pubkey,
    pub salt: [u8; 32],
    pub label: [u8; 32],
    pub precommitment: [u8; 32],
    pub commitment: [u8; 32],
    pub liability: u64,
}

#[event]
pub struct DepositRefunded {
    pub pool: Pubkey,
    pub queue_seq: u64,
    pub amount: u64,
    pub refund_authority: Pubkey,
    pub destination: Pubkey,
    pub liability: u64,
}

#[event]
pub struct LeafInserted {
    pub pool: Pubkey,
    pub queue_seq: u64,
    /// 0 deposit, 1 change.
    pub kind: u8,
    pub leaf_index: u64,
    pub commitment: [u8; 32],
    pub new_root: [u8; 32],
}

#[event]
pub struct QueueItemSkipped {
    pub pool: Pubkey,
    pub queue_seq: u64,
}

#[event]
pub struct ApprovedRootUpdated {
    pub pool: Pubkey,
    pub version: u64,
    pub approved_root: [u8; 32],
}

#[event]
pub struct PrivateSpend {
    pub pool: Pubkey,
    pub nullifier_hash: [u8; 32],
    pub state_root: [u8; 32],
    pub approved_root: [u8; 32],
    pub withdrawn_value: u64,
    pub payout_amount: u64,
    pub relayer_fee: u64,
    pub destination_token_account: Pubkey,
    pub destination_owner: Pubkey,
    pub relayer: Option<Pubkey>,
    pub valid_until_slot: u64,
    pub new_commitment: [u8; 32],
    pub change_queue_seq: u64,
    pub liability: u64,
}

#[event]
pub struct PublicExit {
    pub pool: Pubkey,
    pub nullifier_hash: [u8; 32],
    pub state_root: [u8; 32],
    pub label: [u8; 32],
    pub value: u64,
    pub refund_authority: Pubkey,
    pub destination: Pubkey,
    pub liability: u64,
}

#[event]
pub struct ConfigUpdated {
    pub pool: Pubkey,
    pub deposits_paused: bool,
    pub min_deposit: u64,
    pub max_deposit: u64,
    pub liability_cap: u64,
    pub max_relayer_fee: u64,
}
