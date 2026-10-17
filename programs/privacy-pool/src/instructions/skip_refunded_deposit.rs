use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::PoolError;
use crate::events::QueueItemSkipped;
use crate::state::{PendingDeposit, PoolState, RECORD_REFUNDED, RECORD_SKIPPED};

#[derive(Accounts)]
pub struct SkipRefundedDeposit<'info> {
    pub submitter: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED, pool_state.pool_id.as_ref()], bump = pool_state.bump)]
    pub pool_state: Box<Account<'info, PoolState>>,
    #[account(
        mut,
        constraint = pending_deposit.pool == pool_state.key() @ PoolError::PoolMismatch,
        seeds = [DEPOSIT_SEED, pool_state.key().as_ref(), &pending_deposit.queue_seq.to_le_bytes()],
        bump = pending_deposit.bump,
    )]
    pub pending_deposit: Box<Account<'info, PendingDeposit>>,
}

/// Advances the queue past a refunded record without consuming a leaf index or touching roots.
pub fn handler(ctx: Context<SkipRefundedDeposit>) -> Result<()> {
    let pool_key = ctx.accounts.pool_state.key();
    let queue_seq = ctx.accounts.pending_deposit.queue_seq;
    let pool = &mut ctx.accounts.pool_state;
    require!(queue_seq == pool.queue_head, PoolError::NotQueueHead);
    require!(ctx.accounts.pending_deposit.state == RECORD_REFUNDED, PoolError::QueueItemNotRefunded);
    ctx.accounts.pending_deposit.state = RECORD_SKIPPED;
    pool.queue_head = queue_seq.checked_add(1).ok_or(PoolError::AmountOverflow)?;
    emit!(QueueItemSkipped { pool: pool_key, queue_seq });
    Ok(())
}
