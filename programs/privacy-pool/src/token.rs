//! Minimal original-SPL-Token support: account/mint layout reads and the transfer CPI.
//! Token-2022 accounts are rejected by the owner check.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

use crate::constants::{ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID};
use crate::errors::PoolError;
use crate::state::PoolState;

pub const TOKEN_ACCOUNT_LEN: usize = 165;
pub const MINT_LEN: usize = 82;

const ACCOUNT_STATE_INITIALIZED: u8 = 1;

pub struct TokenAccountView {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub has_delegate: bool,
    pub state: u8,
    pub is_native: bool,
    pub has_close_authority: bool,
}

impl TokenAccountView {
    /// Initialized and not frozen.
    pub fn is_usable(&self) -> bool {
        self.state == ACCOUNT_STATE_INITIALIZED
    }
}

fn pubkey_at(d: &[u8], at: usize) -> Pubkey {
    let mut b = [0u8; 32];
    b.copy_from_slice(&d[at..at + 32]);
    Pubkey::new_from_array(b)
}

fn u64_at(d: &[u8], at: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&d[at..at + 8]);
    u64::from_le_bytes(b)
}

/// COption tag: 0 = None, 1 = Some; anything else is malformed.
fn coption_at(d: &[u8], at: usize) -> Option<bool> {
    match u32::from_le_bytes([d[at], d[at + 1], d[at + 2], d[at + 3]]) {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    }
}

/// Reads an initialized-or-frozen original SPL Token account; fails with `err` otherwise.
pub fn read_token_account(ai: &AccountInfo, err: PoolError) -> Result<TokenAccountView> {
    if *ai.owner != TOKEN_PROGRAM_ID {
        return Err(err.into());
    }
    let d = ai.try_borrow_data()?;
    if d.len() != TOKEN_ACCOUNT_LEN {
        return Err(err.into());
    }
    let (Some(has_delegate), Some(is_native), Some(has_close_authority)) =
        (coption_at(&d, 72), coption_at(&d, 109), coption_at(&d, 129))
    else {
        return Err(err.into());
    };
    let state = d[108];
    if state == 0 || state > 2 {
        return Err(err.into());
    }
    Ok(TokenAccountView {
        mint: pubkey_at(&d, 0),
        owner: pubkey_at(&d, 32),
        amount: u64_at(&d, 64),
        has_delegate,
        state,
        is_native,
        has_close_authority,
    })
}

/// Returns the decimals of an initialized original SPL Token mint.
pub fn read_mint_decimals(ai: &AccountInfo) -> Result<u8> {
    require_keys_eq!(*ai.owner, TOKEN_PROGRAM_ID, PoolError::InvalidMint);
    let d = ai.try_borrow_data()?;
    require!(d.len() == MINT_LEN && d[45] == 1, PoolError::InvalidMint);
    Ok(d[44])
}

pub fn associated_token_address(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), TOKEN_PROGRAM_ID.as_ref(), mint.as_ref()], &ASSOCIATED_TOKEN_PROGRAM_ID).0
}

/// The vault must be the pool's recorded ATA, owned by the vault authority, with no delegate,
/// close authority or native flag, and not frozen.
pub fn check_vault(vault: &AccountInfo, pool: &PoolState, vault_authority: &Pubkey) -> Result<TokenAccountView> {
    require_keys_eq!(*vault.key, pool.vault, PoolError::InvalidVault);
    let v = read_token_account(vault, PoolError::InvalidVault)?;
    require!(
        v.mint == pool.mint
            && v.owner == *vault_authority
            && !v.has_delegate
            && !v.has_close_authority
            && !v.is_native
            && v.is_usable(),
        PoolError::InvalidVault
    );
    Ok(v)
}

/// Checks a payout account: pinned mint, expected owner, usable, and never the vault itself.
pub fn check_payout_account(ai: &AccountInfo, pool: &PoolState, owner: &Pubkey, err: PoolError) -> Result<()> {
    if *ai.key == pool.vault {
        return Err(err.into());
    }
    let t = read_token_account(ai, err)?;
    if t.mint != pool.mint || t.owner != *owner || !t.is_usable() {
        return Err(err.into());
    }
    Ok(())
}

/// SPL Token `Transfer`. Mints are checked by the caller, and the original SPL Token program
/// has no transfer fees, so `TransferChecked` would add an account without adding a check.
pub fn transfer<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    require_keys_eq!(*token_program.key, TOKEN_PROGRAM_ID, PoolError::InvalidTokenProgram);
    let mut data = Vec::with_capacity(9);
    data.push(3u8);
    data.extend_from_slice(&amount.to_le_bytes());
    let ix = Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*from.key, false),
            AccountMeta::new(*to.key, false),
            AccountMeta::new_readonly(*authority.key, true),
        ],
        data,
    };
    invoke_signed(&ix, &[from.clone(), to.clone(), authority.clone(), token_program.clone()], signer_seeds)?;
    Ok(())
}

pub fn token_amount(ai: &AccountInfo) -> Result<u64> {
    let d = ai.try_borrow_data()?;
    require!(d.len() == TOKEN_ACCOUNT_LEN, PoolError::InvalidTokenAccount);
    Ok(u64_at(&d, 64))
}
