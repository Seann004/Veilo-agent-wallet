use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_lang::solana_program::system_instruction;

use crate::constants::VAULT_AUTHORITY_SEED;
use crate::errors::PoolError;

pub fn require_canonical(x: &[u8; 32]) -> Result<()> {
    require!(veilo_crypto::is_canonical(x), PoolError::NonCanonicalFieldElement);
    Ok(())
}

pub fn vault_authority_address(pool: &Pubkey, bump: u8) -> Result<Pubkey> {
    Pubkey::create_program_address(&[VAULT_AUTHORITY_SEED, pool.as_ref(), &[bump]], &crate::ID)
        .map_err(|_| error!(PoolError::InvalidVault))
}

/// Creates a program-owned PDA at `target` after the caller has run every check. The seeds
/// (without bump) must derive `target` with the canonical bump. An account that already exists
/// fails in the System Program with `AccountAlreadyInUse`, which is how replays are rejected.
pub fn create_pda<'info>(
    payer: &AccountInfo<'info>,
    target: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    space: usize,
    seeds: &[&[u8]],
) -> Result<u8> {
    let (expected, bump) = Pubkey::find_program_address(seeds, &crate::ID);
    if expected != *target.key {
        return Err(error!(anchor_lang::error::ErrorCode::ConstraintSeeds));
    }
    let bump_seed = [bump];
    let mut signer: Vec<&[u8]> = seeds.to_vec();
    signer.push(&bump_seed);
    let signer: &[&[&[u8]]] = &[&signer];

    let rent = Rent::get()?.minimum_balance(space);
    let current = target.lamports();
    if current == 0 {
        let ix = system_instruction::create_account(payer.key, target.key, rent, space as u64, &crate::ID);
        invoke_signed(&ix, &[payer.clone(), target.clone(), system_program.clone()], signer)?;
    } else {
        // Someone pre-funded the address: top up, then allocate and assign. Allocate fails if the
        // account already holds data or is not system-owned.
        if current < rent {
            let ix = system_instruction::transfer(payer.key, target.key, rent - current);
            invoke(&ix, &[payer.clone(), target.clone(), system_program.clone()])?;
        }
        invoke_signed(&system_instruction::allocate(target.key, space as u64), &[target.clone(), system_program.clone()], signer)?;
        invoke_signed(&system_instruction::assign(target.key, &crate::ID), &[target.clone(), system_program.clone()], signer)?;
    }
    Ok(bump)
}

/// Serializes a freshly created account (discriminator + Borsh) into its data.
pub fn write_account<T: AccountSerialize>(target: &AccountInfo, value: &T) -> Result<()> {
    let mut data = target.try_borrow_mut_data()?;
    let mut cursor: &mut [u8] = &mut data;
    value.try_serialize(&mut cursor)?;
    Ok(())
}
