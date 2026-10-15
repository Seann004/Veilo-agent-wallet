use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::PoolError;
use crate::events::ConfigUpdated;
use crate::state::{ConfigUpdate, PoolState};

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub config_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [POOL_SEED, pool_state.pool_id.as_ref()],
        bump = pool_state.bump,
        constraint = pool_state.config_authority == config_authority.key() @ PoolError::Unauthorized,
    )]
    pub pool_state: Box<Account<'info, PoolState>>,
}

/// Changes only the bounded deposit/fee settings. Exit, refunds, roots, keys and balances are
/// out of reach, and a cap below the current liability only blocks new deposits.
pub fn handler(ctx: Context<UpdateConfig>, args: ConfigUpdate) -> Result<()> {
    let pool = &mut ctx.accounts.pool_state;
    let deposits_paused = args.deposits_paused.unwrap_or(pool.deposits_paused);
    let min_deposit = args.min_deposit.unwrap_or(pool.min_deposit);
    let max_deposit = args.max_deposit.unwrap_or(pool.max_deposit);
    let liability_cap = args.liability_cap.unwrap_or(pool.liability_cap);
    let max_relayer_fee = args.max_relayer_fee.unwrap_or(pool.max_relayer_fee);
    require!(
        1 <= min_deposit
            && min_deposit <= max_deposit
            && max_deposit <= HARD_MAX_DEPOSIT
            && liability_cap <= HARD_LIABILITY_CAP
            && max_relayer_fee <= HARD_MAX_RELAYER_FEE,
        PoolError::ConfigOutOfBounds
    );
    pool.deposits_paused = deposits_paused;
    pool.min_deposit = min_deposit;
    pool.max_deposit = max_deposit;
    pool.liability_cap = liability_cap;
    pool.max_relayer_fee = max_relayer_fee;
    emit!(ConfigUpdated {
        pool: pool.key(),
        deposits_paused,
        min_deposit,
        max_deposit,
        liability_cap,
        max_relayer_fee,
    });
    Ok(())
}
