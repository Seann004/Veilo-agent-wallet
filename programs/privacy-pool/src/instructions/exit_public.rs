use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::PoolError;
use crate::events::PublicExit;
use crate::state::{Groth16Proof, PoolState, SpentNullifier, NULLIFIER_KIND_EXIT};
use crate::token::{associated_token_address, check_payout_account, check_vault, transfer};
use crate::util::{create_pda, require_canonical, write_account};

#[derive(Accounts)]
pub struct ExitPublic<'info> {
    /// The original refund signer; the exit label is derived from this key.
    pub refund_authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED, pool_state.pool_id.as_ref()], bump = pool_state.bump)]
    pub pool_state: Box<Account<'info, PoolState>>,
    /// CHECK: validated by `check_vault`.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: PDA without data.
    #[account(seeds = [VAULT_AUTHORITY_SEED, pool_state.key().as_ref()], bump = pool_state.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: must be ATA(refund_authority, mint); validated in the handler.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: created by the handler at [b"nullifier", pool, nullifier_hash] after verification.
    #[account(mut)]
    pub spent_nullifier: UncheckedAccount<'info>,
    /// CHECK: address-checked.
    #[account(address = TOKEN_PROGRAM_ID @ PoolError::InvalidTokenProgram)]
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Owner exit. Needs no approved-root membership and ignores the deposit pause.
pub fn handler(
    ctx: Context<ExitPublic>,
    proof: Groth16Proof,
    state_root: [u8; 32],
    nullifier_hash: [u8; 32],
    value: u64,
    salt: [u8; 32],
) -> Result<()> {
    require_canonical(&state_root)?;
    require_canonical(&nullifier_hash)?;
    let pool_key = ctx.accounts.pool_state.key();
    let pool = &ctx.accounts.pool_state;
    require!(pool.is_known_root(&state_root), PoolError::UnknownStateRoot);
    require!(value > 0, PoolError::ZeroValueNotAllowed);

    let authority = ctx.accounts.refund_authority.key();
    let label = veilo_crypto::label(&pool_key.to_bytes(), &pool.mint.to_bytes(), &authority.to_bytes(), &salt);
    require!(!veilo_crypto::is_zero(&label), PoolError::ZeroLabel);

    require_keys_eq!(
        ctx.accounts.destination.key(),
        associated_token_address(&authority, &pool.mint),
        PoolError::InvalidDestination
    );
    check_payout_account(&ctx.accounts.destination, pool, &authority, PoolError::InvalidDestination)?;
    require!(pool.liability >= value, PoolError::LiabilityUnderflow);
    check_vault(&ctx.accounts.vault, pool, &ctx.accounts.vault_authority.key())?;

    let inputs = [state_root, label, veilo_crypto::u64_to_field(value), nullifier_hash];
    veilo_crypto::verify_exit(&(&proof).into(), &inputs).map_err(|_| error!(PoolError::InvalidProof))?;

    let slot = Clock::get()?.slot;
    let nf_bump = create_pda(
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.spent_nullifier,
        &ctx.accounts.system_program.to_account_info(),
        SpentNullifier::SPACE,
        &[NULLIFIER_SEED, pool_key.as_ref(), &nullifier_hash],
    )?;
    write_account(
        &ctx.accounts.spent_nullifier,
        &SpentNullifier { pool: pool_key, kind: NULLIFIER_KIND_EXIT, slot, bump: nf_bump },
    )?;

    let bump = [pool.vault_authority_bump];
    let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, pool_key.as_ref(), &bump];
    transfer(
        &ctx.accounts.token_program,
        &ctx.accounts.vault,
        &ctx.accounts.destination,
        &ctx.accounts.vault_authority,
        value,
        &[seeds],
    )?;

    let pool = &mut ctx.accounts.pool_state;
    pool.add_outflow(value)?;
    emit!(PublicExit {
        pool: pool_key,
        nullifier_hash,
        state_root,
        label,
        value,
        refund_authority: authority,
        destination: ctx.accounts.destination.key(),
        liability: pool.liability,
    });
    Ok(())
}
