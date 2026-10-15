use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;

use crate::constants::*;
use crate::errors::PoolError;
use crate::events::PoolInitialized;
use crate::state::{ApprovalState, PoolState};
use crate::token::{associated_token_address, check_vault, read_mint_decimals};

#[derive(Accounts)]
#[instruction(pool_id: [u8; 32])]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub deployer: Signer<'info>,
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = bpf_loader_upgradeable::ID,
        constraint = program_data.upgrade_authority_address == Some(deployer.key()) @ PoolError::NotUpgradeAuthority,
    )]
    pub program_data: Account<'info, ProgramData>,
    #[account(init, payer = deployer, space = PoolState::SPACE, seeds = [POOL_SEED, pool_id.as_ref()], bump)]
    pub pool_state: Box<Account<'info, PoolState>>,
    /// CHECK: PDA without data; only signs vault transfers.
    #[account(seeds = [VAULT_AUTHORITY_SEED, pool_state.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: validated as an initialized original SPL Token mint in the handler.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: must be ATA(vault_authority, mint); created idempotently by the ATA program.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    #[account(init, payer = deployer, space = ApprovalState::SPACE, seeds = [APPROVAL_SEED, pool_state.key().as_ref()], bump)]
    pub approval_state: Box<Account<'info, ApprovalState>>,
    /// CHECK: address-checked.
    #[account(address = TOKEN_PROGRAM_ID @ PoolError::InvalidTokenProgram)]
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: address-checked.
    #[account(address = ASSOCIATED_TOKEN_PROGRAM_ID)]
    pub associated_token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializePool>,
    pool_id: [u8; 32],
    genesis_hash: [u8; 32],
    expected_decimals: u8,
    approval_authority: Pubkey,
    config_authority: Pubkey,
) -> Result<()> {
    require!(genesis_allowed(&genesis_hash), PoolError::InvalidGenesis);
    let a = &ctx.accounts;
    let decimals = read_mint_decimals(&a.mint)?;
    require!(decimals == expected_decimals, PoolError::InvalidMint);

    let mint = a.mint.key();
    let vault_authority = a.vault_authority.key();
    require_keys_eq!(a.vault.key(), associated_token_address(&vault_authority, &mint), PoolError::InvalidVault);

    // CreateIdempotent: a pre-created ATA is accepted, then validated like any vault use.
    let ix = Instruction {
        program_id: ASSOCIATED_TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(a.deployer.key(), true),
            AccountMeta::new(a.vault.key(), false),
            AccountMeta::new_readonly(vault_authority, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(a.system_program.key(), false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ],
        data: vec![1],
    };
    invoke(
        &ix,
        &[
            a.deployer.to_account_info(),
            a.vault.to_account_info(),
            a.vault_authority.to_account_info(),
            a.mint.to_account_info(),
            a.system_program.to_account_info(),
            a.token_program.to_account_info(),
            a.associated_token_program.to_account_info(),
        ],
    )?;

    let pool_key = ctx.accounts.pool_state.key();
    let pool = &mut ctx.accounts.pool_state;
    pool.protocol_version = PROTOCOL_VERSION;
    pool.bump = ctx.bumps.pool_state;
    pool.vault_authority_bump = ctx.bumps.vault_authority;
    pool.mint_decimals = decimals;
    pool.deposits_paused = false;
    pool.pool_id = pool_id;
    pool.mint = mint;
    pool.token_program = TOKEN_PROGRAM_ID;
    pool.vault = ctx.accounts.vault.key();
    pool.genesis_hash = genesis_hash;
    pool.config_authority = config_authority;
    pool.current_root = veilo_crypto::EMPTY_ROOT;
    pool.root_history = [[0u8; 32]; 32];
    pool.root_history[0] = veilo_crypto::EMPTY_ROOT;
    pool.roots_len = 1;
    pool.roots_next = 1;
    pool.next_leaf_index = 0;
    pool.queue_head = 0;
    pool.queue_tail = 0;
    pool.liability = 0;
    pool.min_deposit = DEFAULT_MIN_DEPOSIT;
    pool.max_deposit = DEFAULT_MAX_DEPOSIT;
    pool.liability_cap = DEFAULT_LIABILITY_CAP;
    pool.max_relayer_fee = DEFAULT_MAX_RELAYER_FEE;
    pool.cumulative_deposited = 0;
    pool.cumulative_outflow = 0;
    pool.reserved = [0u8; 64];

    check_vault(&ctx.accounts.vault, pool, &vault_authority)?;

    let approval = &mut ctx.accounts.approval_state;
    approval.pool = pool_key;
    approval.approval_authority = approval_authority;
    approval.approved_root = veilo_crypto::EMPTY_ROOT;
    approval.version = 0;
    approval.updated_slot = Clock::get()?.slot;
    approval.bump = ctx.bumps.approval_state;

    emit!(PoolInitialized {
        pool: pool_key,
        pool_id,
        mint,
        token_program: TOKEN_PROGRAM_ID,
        vault: pool.vault,
        genesis_hash,
        empty_root: veilo_crypto::EMPTY_ROOT,
        config_authority,
        approval_authority,
        protocol_version: PROTOCOL_VERSION,
    });
    Ok(())
}
