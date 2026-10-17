use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::PoolError;
use crate::events::DepositQueued;
use crate::state::{PendingDeposit, PoolState, SeenPrecommitment, RECORD_PENDING};
use crate::token::{check_vault, read_token_account, token_amount, transfer};
use crate::util::{create_pda, require_canonical, vault_authority_address, write_account};

#[derive(Accounts)]
pub struct Deposit<'info> {
    /// Refund authority bound into the label, and authority of `source`.
    pub depositor: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED, pool_state.pool_id.as_ref()], bump = pool_state.bump)]
    pub pool_state: Box<Account<'info, PoolState>>,
    /// CHECK: validated in the handler (pinned mint, owned by the depositor).
    #[account(mut)]
    pub source: UncheckedAccount<'info>,
    /// CHECK: validated by `check_vault`.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: created by the handler at [b"deposit", pool, queue_tail LE] after all checks.
    #[account(mut)]
    pub pending_deposit: UncheckedAccount<'info>,
    /// CHECK: created by the handler at [b"precommitment", pool, precommitment] after all checks.
    #[account(mut)]
    pub seen_precommitment: UncheckedAccount<'info>,
    /// CHECK: address-checked.
    #[account(address = TOKEN_PROGRAM_ID @ PoolError::InvalidTokenProgram)]
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Deposit>, amount: u64, precommitment: [u8; 32], salt: [u8; 32]) -> Result<()> {
    let pool_key = ctx.accounts.pool_state.key();
    let depositor = ctx.accounts.depositor.key();
    let pool = &ctx.accounts.pool_state;

    require!(!pool.deposits_paused, PoolError::DepositsPaused);
    require!(amount >= pool.min_deposit, PoolError::DepositBelowMinimum);
    require!(amount <= pool.max_deposit, PoolError::DepositAboveMaximum);
    let liability = pool.liability.checked_add(amount).ok_or(PoolError::AmountOverflow)?;
    require!(liability <= pool.liability_cap, PoolError::LiabilityCapExceeded);
    pool.require_capacity(CHANGE_RESERVE)?;
    require!(pool.live()? < QUEUE_MAX_LIVE_DEPOSITS, PoolError::QueueFull);
    require_canonical(&precommitment)?;
    require!(!veilo_crypto::is_zero(&precommitment), PoolError::ZeroValueNotAllowed);

    let label = veilo_crypto::label(&pool_key.to_bytes(), &pool.mint.to_bytes(), &depositor.to_bytes(), &salt);
    require!(!veilo_crypto::is_zero(&label), PoolError::ZeroLabel);

    let source = read_token_account(&ctx.accounts.source, PoolError::InvalidTokenAccount)?;
    require_keys_eq!(source.mint, pool.mint, PoolError::InvalidMint);
    require_keys_eq!(source.owner, depositor, PoolError::InvalidTokenAccount);
    require_keys_neq!(ctx.accounts.source.key(), pool.vault, PoolError::InvalidTokenAccount);
    let vault_authority = vault_authority_address(&pool_key, pool.vault_authority_bump)?;
    let vault_before = check_vault(&ctx.accounts.vault, pool, &vault_authority)?.amount;

    transfer(
        &ctx.accounts.token_program,
        &ctx.accounts.source,
        &ctx.accounts.vault,
        &ctx.accounts.depositor,
        amount,
        &[],
    )?;
    let received = token_amount(&ctx.accounts.vault)?.checked_sub(vault_before).ok_or(PoolError::TransferAmountMismatch)?;
    require!(received == amount, PoolError::TransferAmountMismatch);

    let commitment =
        veilo_crypto::deposit_commitment(amount, &label, &precommitment).map_err(|_| error!(PoolError::NonCanonicalFieldElement))?;
    require!(!veilo_crypto::is_zero(&commitment), PoolError::ZeroCommitment);

    let queue_seq = pool.queue_tail;
    let slot = Clock::get()?.slot;
    let payer = ctx.accounts.payer.to_account_info();
    let system = ctx.accounts.system_program.to_account_info();

    let pd_bump = create_pda(
        &payer,
        &ctx.accounts.pending_deposit,
        &system,
        PendingDeposit::SPACE,
        &[DEPOSIT_SEED, pool_key.as_ref(), &queue_seq.to_le_bytes()],
    )?;
    write_account(
        &ctx.accounts.pending_deposit,
        &PendingDeposit {
            pool: pool_key,
            queue_seq,
            refund_authority: depositor,
            salt,
            label,
            precommitment,
            commitment,
            amount,
            state: RECORD_PENDING,
            leaf_index: u64::MAX,
            created_slot: slot,
            bump: pd_bump,
        },
    )?;
    let seen_bump = create_pda(
        &payer,
        &ctx.accounts.seen_precommitment,
        &system,
        SeenPrecommitment::SPACE,
        &[PRECOMMITMENT_SEED, pool_key.as_ref(), &precommitment],
    )?;
    write_account(&ctx.accounts.seen_precommitment, &SeenPrecommitment { pool: pool_key, queue_seq, bump: seen_bump })?;

    let pool = &mut ctx.accounts.pool_state;
    pool.queue_tail = queue_seq.checked_add(1).ok_or(PoolError::AmountOverflow)?;
    pool.liability = liability;
    pool.cumulative_deposited = pool.cumulative_deposited.checked_add(amount).ok_or(PoolError::AmountOverflow)?;

    emit!(DepositQueued {
        pool: pool_key,
        queue_seq,
        amount,
        refund_authority: depositor,
        salt,
        label,
        precommitment,
        commitment,
        liability,
    });
    Ok(())
}
