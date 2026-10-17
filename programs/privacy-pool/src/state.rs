use anchor_lang::prelude::*;

use crate::constants::{ROOT_HISTORY, TREE_CAPACITY};
use crate::errors::PoolError;

pub const RECORD_PENDING: u8 = 0;
pub const RECORD_INSERTED: u8 = 1;
pub const RECORD_REFUNDED: u8 = 2;
pub const RECORD_SKIPPED: u8 = 3;

pub const NULLIFIER_KIND_SPEND: u8 = 1;
pub const NULLIFIER_KIND_EXIT: u8 = 2;

/// Groth16 proof in groth16-solana encoding (`a` already negated by the prover).
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Groth16Proof {
    pub a: [u8; 64],
    pub b: [u8; 128],
    pub c: [u8; 64],
}

impl From<&Groth16Proof> for veilo_crypto::Groth16Proof {
    fn from(p: &Groth16Proof) -> Self {
        veilo_crypto::Groth16Proof { a: p.a, b: p.b, c: p.c }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct WithdrawalIntent {
    pub destination_token_account: Pubkey,
    pub destination_owner: Pubkey,
    pub payout_amount: u64,
    pub relayer_fee: u64,
    pub relayer: Option<Pubkey>,
    pub relayer_fee_token_account: Option<Pubkey>,
    pub valid_until_slot: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ConfigUpdate {
    pub deposits_paused: Option<bool>,
    pub min_deposit: Option<u64>,
    pub max_deposit: Option<u64>,
    pub liability_cap: Option<u64>,
    pub max_relayer_fee: Option<u64>,
}

#[account]
pub struct PoolState {
    pub protocol_version: u8,
    pub bump: u8,
    pub vault_authority_bump: u8,
    pub mint_decimals: u8,
    pub deposits_paused: bool,
    pub roots_len: u8,
    pub roots_next: u8,
    pub pool_id: [u8; 32],
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub vault: Pubkey,
    pub genesis_hash: [u8; 32],
    pub config_authority: Pubkey,
    pub current_root: [u8; 32],
    pub root_history: [[u8; 32]; 32],
    pub next_leaf_index: u64,
    pub queue_head: u64,
    pub queue_tail: u64,
    pub liability: u64,
    pub min_deposit: u64,
    pub max_deposit: u64,
    pub liability_cap: u64,
    pub max_relayer_fee: u64,
    pub cumulative_deposited: u64,
    pub cumulative_outflow: u64,
    pub reserved: [u8; 64],
}

impl PoolState {
    pub const SPACE: usize = 1_407;

    /// True iff `root` is one of the `roots_len` live history entries.
    pub fn is_known_root(&self, root: &[u8; 32]) -> bool {
        self.root_history[..self.roots_len as usize].iter().any(|r| r == root)
    }

    pub fn push_root(&mut self, root: [u8; 32]) {
        self.root_history[self.roots_next as usize] = root;
        self.roots_next = (self.roots_next + 1) % ROOT_HISTORY;
        self.roots_len = (self.roots_len + 1).min(ROOT_HISTORY);
        self.current_root = root;
    }

    /// Queue records not yet inserted or skipped (deposits and change).
    pub fn live(&self) -> Result<u64> {
        self.queue_tail.checked_sub(self.queue_head).ok_or_else(|| error!(PoolError::AmountOverflow))
    }

    /// Fails unless one more leaf can be reserved while leaving `headroom` slots free.
    pub fn require_capacity(&self, headroom: u64) -> Result<()> {
        let reserved = self.next_leaf_index.checked_add(self.live()?).ok_or(PoolError::AmountOverflow)?;
        let limit = TREE_CAPACITY.checked_sub(headroom).ok_or(PoolError::AmountOverflow)?;
        require!(reserved.checked_add(1).ok_or(PoolError::AmountOverflow)? <= limit, PoolError::TreeCapacityExhausted);
        Ok(())
    }

    pub fn add_outflow(&mut self, amount: u64) -> Result<()> {
        self.liability = self.liability.checked_sub(amount).ok_or(PoolError::LiabilityUnderflow)?;
        self.cumulative_outflow = self.cumulative_outflow.checked_add(amount).ok_or(PoolError::AmountOverflow)?;
        Ok(())
    }
}

#[account]
pub struct PendingDeposit {
    pub pool: Pubkey,
    pub queue_seq: u64,
    pub refund_authority: Pubkey,
    pub salt: [u8; 32],
    pub label: [u8; 32],
    pub precommitment: [u8; 32],
    pub commitment: [u8; 32],
    pub amount: u64,
    pub state: u8,
    pub leaf_index: u64,
    pub created_slot: u64,
    pub bump: u8,
}

impl PendingDeposit {
    pub const SPACE: usize = 234;
}

#[account]
pub struct PendingChange {
    pub pool: Pubkey,
    pub queue_seq: u64,
    pub nullifier_hash: [u8; 32],
    pub commitment: [u8; 32],
    pub state: u8,
    pub leaf_index: u64,
    pub created_slot: u64,
    pub bump: u8,
}

impl PendingChange {
    pub const SPACE: usize = 130;
}

#[account]
pub struct SeenPrecommitment {
    pub pool: Pubkey,
    pub queue_seq: u64,
    pub bump: u8,
}

impl SeenPrecommitment {
    pub const SPACE: usize = 49;
}

#[account]
pub struct SpentNullifier {
    pub pool: Pubkey,
    pub kind: u8,
    pub slot: u64,
    pub bump: u8,
}

impl SpentNullifier {
    pub const SPACE: usize = 50;
}

#[account]
pub struct ApprovalState {
    pub pool: Pubkey,
    pub approval_authority: Pubkey,
    pub approved_root: [u8; 32],
    pub version: u64,
    pub updated_slot: u64,
    pub bump: u8,
}

impl ApprovalState {
    pub const SPACE: usize = 121;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn serialized_len<T: AccountSerialize>(v: &T) -> usize {
        let mut out = Vec::new();
        v.try_serialize(&mut out).unwrap();
        out.len()
    }

    #[test]
    fn account_sizes_match_protocol() {
        let k = Pubkey::default();
        let pool = PoolState {
            protocol_version: 1, bump: 0, vault_authority_bump: 0, mint_decimals: 6, deposits_paused: false,
            roots_len: 1, roots_next: 1, pool_id: [0; 32], mint: k, token_program: k, vault: k, genesis_hash: [0; 32],
            config_authority: k, current_root: [0; 32], root_history: [[0; 32]; 32], next_leaf_index: 0, queue_head: 0,
            queue_tail: 0, liability: 0, min_deposit: 0, max_deposit: 0, liability_cap: 0, max_relayer_fee: 0,
            cumulative_deposited: 0, cumulative_outflow: 0, reserved: [0; 64],
        };
        assert_eq!(serialized_len(&pool), PoolState::SPACE);
        let pd = PendingDeposit {
            pool: k, queue_seq: 0, refund_authority: k, salt: [0; 32], label: [0; 32], precommitment: [0; 32],
            commitment: [0; 32], amount: 0, state: 0, leaf_index: 0, created_slot: 0, bump: 0,
        };
        assert_eq!(serialized_len(&pd), PendingDeposit::SPACE);
        let pc = PendingChange {
            pool: k, queue_seq: 0, nullifier_hash: [0; 32], commitment: [0; 32], state: 0, leaf_index: 0, created_slot: 0, bump: 0,
        };
        assert_eq!(serialized_len(&pc), PendingChange::SPACE);
        assert_eq!(serialized_len(&SeenPrecommitment { pool: k, queue_seq: 0, bump: 0 }), SeenPrecommitment::SPACE);
        assert_eq!(serialized_len(&SpentNullifier { pool: k, kind: 1, slot: 0, bump: 0 }), SpentNullifier::SPACE);
        let ap = ApprovalState { pool: k, approval_authority: k, approved_root: [0; 32], version: 0, updated_slot: 0, bump: 0 };
        assert_eq!(serialized_len(&ap), ApprovalState::SPACE);
    }

    #[test]
    fn root_history_ring_keeps_newest_32() {
        let mut pool = PoolState {
            protocol_version: 1, bump: 0, vault_authority_bump: 0, mint_decimals: 6, deposits_paused: false,
            roots_len: 1, roots_next: 1, pool_id: [0; 32], mint: Pubkey::default(), token_program: Pubkey::default(),
            vault: Pubkey::default(), genesis_hash: [0; 32], config_authority: Pubkey::default(), current_root: [0; 32],
            root_history: [[0; 32]; 32], next_leaf_index: 0, queue_head: 0, queue_tail: 0, liability: 0, min_deposit: 0,
            max_deposit: 0, liability_cap: 0, max_relayer_fee: 0, cumulative_deposited: 0, cumulative_outflow: 0, reserved: [0; 64],
        };
        pool.root_history[0] = [0xee; 32];
        pool.current_root = [0xee; 32];
        for i in 1..=40u8 {
            pool.push_root([i; 32]);
            assert_eq!(pool.current_root, [i; 32]);
        }
        assert_eq!(pool.roots_len, 32);
        assert!(!pool.is_known_root(&[0xee; 32]));
        assert!(!pool.is_known_root(&[8; 32]));
        for i in 9..=40u8 {
            assert!(pool.is_known_root(&[i; 32]), "root {i}");
        }
    }
}
