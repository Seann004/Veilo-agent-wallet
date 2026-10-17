//! Veilo note-based privacy pool (protocol v1, docs/protocol.md section 8).
//! There is no sweep, admin withdrawal, close or key-replacement instruction.

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;
pub mod token;
pub mod util;

use instructions::*;
use state::{ConfigUpdate, Groth16Proof, WithdrawalIntent};

declare_id!("3B6Db74gPstdciTfr1gdYG4DuhA2DpTGqYM9jgthYUrq");

#[program]
pub mod privacy_pool {
    use super::*;

    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        pool_id: [u8; 32],
        genesis_hash: [u8; 32],
        expected_decimals: u8,
        approval_authority: Pubkey,
        config_authority: Pubkey,
    ) -> Result<()> {
        instructions::initialize_pool::handler(ctx, pool_id, genesis_hash, expected_decimals, approval_authority, config_authority)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64, precommitment: [u8; 32], salt: [u8; 32]) -> Result<()> {
        instructions::deposit::handler(ctx, amount, precommitment, salt)
    }

    pub fn refund_pending_deposit(ctx: Context<RefundPendingDeposit>) -> Result<()> {
        instructions::refund_pending_deposit::handler(ctx)
    }

    pub fn insert_leaf(ctx: Context<InsertLeaf>, proof: Groth16Proof, new_root: [u8; 32]) -> Result<()> {
        instructions::insert_leaf::handler(ctx, proof, new_root)
    }

    pub fn skip_refunded_deposit(ctx: Context<SkipRefundedDeposit>) -> Result<()> {
        instructions::skip_refunded_deposit::handler(ctx)
    }

    pub fn update_approved_root(ctx: Context<UpdateApprovedRoot>, new_root: [u8; 32]) -> Result<()> {
        instructions::update_approved_root::handler(ctx, new_root)
    }

    pub fn spend_private(
        ctx: Context<SpendPrivate>,
        proof: Groth16Proof,
        state_root: [u8; 32],
        nullifier_hash: [u8; 32],
        new_commitment: [u8; 32],
        intent: WithdrawalIntent,
    ) -> Result<()> {
        instructions::spend_private::handler(ctx, proof, state_root, nullifier_hash, new_commitment, intent)
    }

    pub fn exit_public(
        ctx: Context<ExitPublic>,
        proof: Groth16Proof,
        state_root: [u8; 32],
        nullifier_hash: [u8; 32],
        value: u64,
        salt: [u8; 32],
    ) -> Result<()> {
        instructions::exit_public::handler(ctx, proof, state_root, nullifier_hash, value, salt)
    }

    pub fn update_config(ctx: Context<UpdateConfig>, args: ConfigUpdate) -> Result<()> {
        instructions::update_config::handler(ctx, args)
    }
}
