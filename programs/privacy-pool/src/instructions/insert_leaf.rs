use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::PoolError;
use crate::events::LeafInserted;
use crate::state::{Groth16Proof, PendingChange, PendingDeposit, PoolState, RECORD_INSERTED, RECORD_PENDING};
use crate::util::require_canonical;

#[derive(Accounts)]
pub struct InsertLeaf<'info> {
    pub submitter: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED, pool_state.pool_id.as_ref()], bump = pool_state.bump)]
    pub pool_state: Box<Account<'info, PoolState>>,
    #[account(
        mut,
        constraint = pending_deposit.pool == pool_state.key() @ PoolError::PoolMismatch,
        seeds = [DEPOSIT_SEED, pool_state.key().as_ref(), &pending_deposit.queue_seq.to_le_bytes()],
        bump = pending_deposit.bump,
    )]
    pub pending_deposit: Option<Box<Account<'info, PendingDeposit>>>,
    #[account(
        mut,
        constraint = pending_change.pool == pool_state.key() @ PoolError::PoolMismatch,
        seeds = [CHANGE_SEED, pool_state.key().as_ref(), pending_change.nullifier_hash.as_ref()],
        bump = pending_change.bump,
    )]
    pub pending_change: Option<Box<Account<'info, PendingChange>>>,
}

pub fn handler(ctx: Context<InsertLeaf>, proof: Groth16Proof, new_root: [u8; 32]) -> Result<()> {
    let pool_key = ctx.accounts.pool_state.key();
    let a = &mut *ctx.accounts;
    let (kind, queue_seq, state, commitment) = match (&a.pending_deposit, &a.pending_change) {
        (Some(d), None) => (0u8, d.queue_seq, d.state, d.commitment),
        (None, Some(c)) => (1u8, c.queue_seq, c.state, c.commitment),
        _ => return err!(PoolError::InvalidQueueItem),
    };
    let pool = &mut a.pool_state;
    require!(queue_seq == pool.queue_head, PoolError::NotQueueHead);
    require!(state == RECORD_PENDING, PoolError::QueueItemNotPending);
    require!(pool.next_leaf_index < TREE_CAPACITY, PoolError::TreeCapacityExhausted);
    require_canonical(&new_root)?;

    let leaf_index = pool.next_leaf_index;
    let inputs = [pool.current_root, new_root, veilo_crypto::u64_to_field(leaf_index), commitment];
    veilo_crypto::verify_insert(&(&proof).into(), &inputs).map_err(|_| error!(PoolError::InvalidProof))?;

    pool.push_root(new_root);
    pool.next_leaf_index = leaf_index.checked_add(1).ok_or(PoolError::AmountOverflow)?;
    pool.queue_head = queue_seq.checked_add(1).ok_or(PoolError::AmountOverflow)?;
    match (&mut a.pending_deposit, &mut a.pending_change) {
        (Some(d), None) => {
            d.state = RECORD_INSERTED;
            d.leaf_index = leaf_index;
        }
        (None, Some(c)) => {
            c.state = RECORD_INSERTED;
            c.leaf_index = leaf_index;
        }
        _ => return err!(PoolError::InvalidQueueItem),
    }

    emit!(LeafInserted { pool: pool_key, queue_seq, kind, leaf_index, commitment, new_root });
    Ok(())
}
