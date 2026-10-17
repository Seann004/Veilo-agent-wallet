use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::PoolError;
use crate::events::DepositRefunded;
use crate::state::{PendingDeposit, PoolState, RECORD_PENDING, RECORD_REFUNDED};
use crate::token::{associated_token_address, check_payout_account, check_vault, transfer};

#[derive(Accounts)]
pub struct RefundPendingDeposit<'info> {
    pub refund_authority: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED, pool_state.pool_id.as_ref()], bump = pool_state.bump)]
    pub pool_state: Box<Account<'info, PoolState>>,
    #[account(
        mut,
        constraint = pending_deposit.pool == pool_state.key() @ PoolError::PoolMismatch,
        seeds = [DEPOSIT_SEED, pool_state.key().as_ref(), &pending_deposit.queue_seq.to_le_bytes()],
        bump = pending_deposit.bump,
    )]
    pub pending_deposit: Box<Account<'info, PendingDeposit>>,
    /// CHECK: validated by `check_vault`.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: PDA without data.
    #[account(seeds = [VAULT_AUTHORITY_SEED, pool_state.key().as_ref()], bump = pool_state.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: must be ATA(refund_authority, mint); validated in the handler.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: address-checked.
    #[account(address = TOKEN_PROGRAM_ID @ PoolError::InvalidTokenProgram)]
    pub token_program: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<RefundPendingDeposit>) -> Result<()> {
    let pool_key = ctx.accounts.pool_state.key();
    let authority = ctx.accounts.refund_authority.key();
    let record = &ctx.accounts.pending_deposit;
    require_keys_eq!(authority, record.refund_authority, PoolError::Unauthorized);
    require!(record.state == RECORD_PENDING, PoolError::DepositNotPending);

    let pool = &ctx.accounts.pool_state;
    require_keys_eq!(
        ctx.accounts.destination.key(),
        associated_token_address(&authority, &pool.mint),
        PoolError::InvalidDestination
    );
    check_payout_account(&ctx.accounts.destination, pool, &authority, PoolError::InvalidDestination)?;
    check_vault(&ctx.accounts.vault, pool, &ctx.accounts.vault_authority.key())?;

    let amount = record.amount;
    let bump = [pool.vault_authority_bump];
    let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, pool_key.as_ref(), &bump];
    transfer(
        &ctx.accounts.token_program,
        &ctx.accounts.vault,
        &ctx.accounts.destination,
        &ctx.accounts.vault_authority,
        amount,
        &[seeds],
    )?;

    let queue_seq = record.queue_seq;
    ctx.accounts.pending_deposit.state = RECORD_REFUNDED;
    let pool = &mut ctx.accounts.pool_state;
    pool.add_outflow(amount)?;

    emit!(DepositRefunded {
        pool: pool_key,
        queue_seq,
        amount,
        refund_authority: authority,
        destination: ctx.accounts.destination.key(),
        liability: pool.liability,
    });
    Ok(())
}
