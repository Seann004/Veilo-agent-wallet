use anchor_lang::prelude::*;
use veilo_crypto::{IntentFields, IntentRuleError};

use crate::constants::*;
use crate::errors::PoolError;
use crate::events::PrivateSpend;
use crate::state::{
    ApprovalState, Groth16Proof, PendingChange, PoolState, SpentNullifier, WithdrawalIntent, NULLIFIER_KIND_SPEND,
    RECORD_PENDING,
};
use crate::token::{check_payout_account, check_vault, transfer};
use crate::util::{create_pda, require_canonical, write_account};

#[derive(Accounts)]
pub struct SpendPrivate<'info> {
    /// Fee and rent sponsor.
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Required when the intent names a relayer, and must equal it.
    pub relayer: Option<Signer<'info>>,
    #[account(mut, seeds = [POOL_SEED, pool_state.pool_id.as_ref()], bump = pool_state.bump)]
    pub pool_state: Box<Account<'info, PoolState>>,
    #[account(
        constraint = approval_state.pool == pool_state.key() @ PoolError::PoolMismatch,
        seeds = [APPROVAL_SEED, pool_state.key().as_ref()],
        bump = approval_state.bump,
    )]
    pub approval_state: Box<Account<'info, ApprovalState>>,
    /// CHECK: validated by `check_vault`.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: PDA without data.
    #[account(seeds = [VAULT_AUTHORITY_SEED, pool_state.key().as_ref()], bump = pool_state.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: must equal intent.destination_token_account; validated in the handler.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: must equal intent.relayer_fee_token_account when a fee is paid; validated in the handler.
    #[account(mut)]
    pub relayer_fee_account: Option<UncheckedAccount<'info>>,
    /// CHECK: created by the handler at [b"nullifier", pool, nullifier_hash] after verification.
    #[account(mut)]
    pub spent_nullifier: UncheckedAccount<'info>,
    /// CHECK: created by the handler at [b"change", pool, nullifier_hash] after verification.
    #[account(mut)]
    pub pending_change: UncheckedAccount<'info>,
    /// CHECK: address-checked.
    #[account(address = TOKEN_PROGRAM_ID @ PoolError::InvalidTokenProgram)]
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

fn intent_error(e: IntentRuleError) -> Error {
    match e {
        IntentRuleError::PayoutZero => error!(PoolError::PayoutZero),
        IntentRuleError::AmountOverflow => error!(PoolError::AmountOverflow),
        IntentRuleError::RelayerFeeNotAllowed => error!(PoolError::RelayerFeeNotAllowed),
        IntentRuleError::RelayerFeeAccountMismatch => error!(PoolError::RelayerFeeAccountMismatch),
        IntentRuleError::IntentExpired => error!(PoolError::IntentExpired),
        IntentRuleError::IntentTooFarInFuture => error!(PoolError::IntentTooFarInFuture),
    }
}

pub fn handler(
    ctx: Context<SpendPrivate>,
    proof: Groth16Proof,
    state_root: [u8; 32],
    nullifier_hash: [u8; 32],
    new_commitment: [u8; 32],
    intent: WithdrawalIntent,
) -> Result<()> {
    require_canonical(&state_root)?;
    require_canonical(&nullifier_hash)?;
    require_canonical(&new_commitment)?;
    require!(!veilo_crypto::is_zero(&new_commitment), PoolError::ZeroCommitment);

    let pool_key = ctx.accounts.pool_state.key();
    let pool = &ctx.accounts.pool_state;
    require!(pool.is_known_root(&state_root), PoolError::UnknownStateRoot);

    let program_id = crate::ID.to_bytes();
    let pool_bytes = pool_key.to_bytes();
    let mint = pool.mint.to_bytes();
    let destination_token_account = intent.destination_token_account.to_bytes();
    let destination_owner = intent.destination_owner.to_bytes();
    let relayer = intent.relayer.map(|k| k.to_bytes());
    let fee_account = intent.relayer_fee_token_account.map(|k| k.to_bytes());
    let fields = IntentFields {
        program_id: &program_id,
        pool: &pool_bytes,
        genesis_hash: &pool.genesis_hash,
        mint: &mint,
        destination_token_account: &destination_token_account,
        destination_owner: &destination_owner,
        payout_amount: intent.payout_amount,
        relayer_fee: intent.relayer_fee,
        relayer: relayer.as_ref(),
        relayer_fee_token_account: fee_account.as_ref(),
        valid_until_slot: intent.valid_until_slot,
    };
    let slot = Clock::get()?.slot;
    let withdrawn = veilo_crypto::check_intent(&fields, pool.max_relayer_fee, slot).map_err(intent_error)?;

    if let Some(k) = intent.relayer {
        let signer = ctx.accounts.relayer.as_ref().ok_or(PoolError::RelayerMismatch)?;
        require_keys_eq!(signer.key(), k, PoolError::RelayerMismatch);
        if let Some(fee_key) = intent.relayer_fee_token_account {
            let fee_ai = ctx.accounts.relayer_fee_account.as_ref().ok_or(PoolError::RelayerFeeAccountMismatch)?;
            require_keys_eq!(fee_ai.key(), fee_key, PoolError::RelayerFeeAccountMismatch);
            check_payout_account(fee_ai, pool, &k, PoolError::RelayerFeeAccountMismatch)?;
        }
    }

    require_keys_eq!(ctx.accounts.destination.key(), intent.destination_token_account, PoolError::InvalidDestination);
    check_payout_account(&ctx.accounts.destination, pool, &intent.destination_owner, PoolError::InvalidDestination)?;
    pool.require_capacity(0)?;
    require!(pool.liability >= withdrawn, PoolError::LiabilityUnderflow);
    check_vault(&ctx.accounts.vault, pool, &ctx.accounts.vault_authority.key())?;

    let approved_root = ctx.accounts.approval_state.approved_root;
    let context = veilo_crypto::intent_context(&fields);
    let inputs = [context, state_root, approved_root, nullifier_hash, veilo_crypto::u64_to_field(withdrawn), new_commitment];
    veilo_crypto::verify_spend(&(&proof).into(), &inputs).map_err(|_| error!(PoolError::InvalidProof))?;

    let payer = ctx.accounts.payer.to_account_info();
    let system = ctx.accounts.system_program.to_account_info();
    let nf_bump = create_pda(
        &payer,
        &ctx.accounts.spent_nullifier,
        &system,
        SpentNullifier::SPACE,
        &[NULLIFIER_SEED, pool_key.as_ref(), &nullifier_hash],
    )?;
    write_account(
        &ctx.accounts.spent_nullifier,
        &SpentNullifier { pool: pool_key, kind: NULLIFIER_KIND_SPEND, slot, bump: nf_bump },
    )?;
    let change_seq = pool.queue_tail;
    let change_bump = create_pda(
        &payer,
        &ctx.accounts.pending_change,
        &system,
        PendingChange::SPACE,
        &[CHANGE_SEED, pool_key.as_ref(), &nullifier_hash],
    )?;
    write_account(
        &ctx.accounts.pending_change,
        &PendingChange {
            pool: pool_key,
            queue_seq: change_seq,
            nullifier_hash,
            commitment: new_commitment,
            state: RECORD_PENDING,
            leaf_index: u64::MAX,
            created_slot: slot,
            bump: change_bump,
        },
    )?;

    let bump = [pool.vault_authority_bump];
    let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, pool_key.as_ref(), &bump];
    transfer(
        &ctx.accounts.token_program,
        &ctx.accounts.vault,
        &ctx.accounts.destination,
        &ctx.accounts.vault_authority,
        intent.payout_amount,
        &[seeds],
    )?;
    if intent.relayer_fee > 0 {
        let fee_ai = ctx.accounts.relayer_fee_account.as_ref().ok_or(PoolError::RelayerFeeAccountMismatch)?;
        transfer(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            fee_ai,
            &ctx.accounts.vault_authority,
            intent.relayer_fee,
            &[seeds],
        )?;
    }

    let pool = &mut ctx.accounts.pool_state;
    pool.queue_tail = change_seq.checked_add(1).ok_or(PoolError::AmountOverflow)?;
    pool.add_outflow(withdrawn)?;

    emit!(PrivateSpend {
        pool: pool_key,
        nullifier_hash,
        state_root,
        approved_root,
        withdrawn_value: withdrawn,
        payout_amount: intent.payout_amount,
        relayer_fee: intent.relayer_fee,
        destination_token_account: intent.destination_token_account,
        destination_owner: intent.destination_owner,
        relayer: intent.relayer,
        valid_until_slot: intent.valid_until_slot,
        new_commitment,
        change_queue_seq: change_seq,
        liability: pool.liability,
    });
    Ok(())
}
