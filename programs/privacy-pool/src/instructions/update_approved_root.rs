use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::PoolError;
use crate::events::ApprovedRootUpdated;
use crate::state::{ApprovalState, PoolState};
use crate::util::require_canonical;

#[derive(Accounts)]
pub struct UpdateApprovedRoot<'info> {
    pub approval_authority: Signer<'info>,
    #[account(seeds = [POOL_SEED, pool_state.pool_id.as_ref()], bump = pool_state.bump)]
    pub pool_state: Box<Account<'info, PoolState>>,
    #[account(
        mut,
        constraint = approval_state.pool == pool_state.key() @ PoolError::PoolMismatch,
        constraint = approval_state.approval_authority == approval_authority.key() @ PoolError::Unauthorized,
        seeds = [APPROVAL_SEED, pool_state.key().as_ref()],
        bump = approval_state.bump,
    )]
    pub approval_state: Box<Account<'info, ApprovalState>>,
}

pub fn handler(ctx: Context<UpdateApprovedRoot>, new_root: [u8; 32]) -> Result<()> {
    require_canonical(&new_root)?;
    let approval = &mut ctx.accounts.approval_state;
    approval.approved_root = new_root;
    approval.version = approval.version.checked_add(1).ok_or(PoolError::AmountOverflow)?;
    approval.updated_slot = Clock::get()?.slot;
    emit!(ApprovedRootUpdated { pool: approval.pool, version: approval.version, approved_root: new_root });
    Ok(())
}
