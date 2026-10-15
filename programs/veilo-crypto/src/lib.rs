//! Veilo protocol v1 encodings shared by the `privacy-pool` program and its tests:
//! canonical field checks, label and intent-context hashing, the deposit leaf and the
//! Groth16 verifying keys. SHA-256 and Poseidon use the Solana syscalls on-chain and their
//! reference implementations off-chain.

use groth16_solana::{errors::Groth16Error, groth16::Groth16Verifier};
use solana_poseidon::{Endianness, Parameters, PoseidonSyscallError};

pub mod vk;

pub const PROTOCOL_VERSION: u8 = 1;
pub const TREE_DEPTH: usize = 16;
pub const APPROVED_TREE_DEPTH: usize = 16;
pub const TREE_CAPACITY: u64 = 1 << TREE_DEPTH;

pub const LABEL_DOMAIN: &[u8; 14] = b"veilo/label/v1";
pub const INTENT_DOMAIN: &[u8; 15] = b"veilo/intent/v1";
pub const LABEL_PREIMAGE_LEN: usize = 142;
pub const INTENT_BYTES_LEN: usize = 296;

/// be32(r), the BN254 scalar field modulus.
pub const FIELD_MODULUS_BE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

/// be32(Z[16]): root of the empty depth-16 tree (both the commitment and approved trees).
pub const EMPTY_ROOT: [u8; 32] = [
    0x2a, 0x7c, 0x7c, 0x9b, 0x6c, 0xe5, 0x88, 0x0b, 0x9f, 0x6f, 0x22, 0x8d, 0x72, 0xbf, 0x6a, 0x57,
    0x5a, 0x52, 0x6f, 0x29, 0xc6, 0x6e, 0xcc, 0xee, 0xf8, 0xb7, 0x53, 0xd3, 0x8b, 0xba, 0x73, 0x23,
];

/// True iff `x` is the canonical big-endian encoding of a value below r.
pub fn is_canonical(x: &[u8; 32]) -> bool {
    // Big-endian byte arrays of equal length compare like the integers they encode.
    x < &FIELD_MODULUS_BE
}

pub fn is_zero(x: &[u8; 32]) -> bool {
    x.iter().all(|b| *b == 0)
}

/// be32(v) for a u64 amount: 24 zero bytes then u64_be(v).
pub fn u64_to_field(v: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&v.to_be_bytes());
    out
}

/// be32(int_be(SHA256(parts)[0..31])), always below r.
fn sha256_first31(parts: &[&[u8]]) -> [u8; 32] {
    let digest = solana_sha256_hasher::hashv(parts).to_bytes();
    let mut out = [0u8; 32];
    out[1..].copy_from_slice(&digest[..31]);
    out
}

/// Note label for (PoolState address, mint, refund authority, salt). The caller rejects zero.
pub fn label(pool: &[u8; 32], mint: &[u8; 32], refund_authority: &[u8; 32], salt: &[u8; 32]) -> [u8; 32] {
    sha256_first31(&[LABEL_DOMAIN, pool, mint, refund_authority, salt])
}

/// Withdrawal intent plus the context fields the program takes from its own id and PoolState.
#[derive(Clone, Copy, Debug)]
pub struct IntentFields<'a> {
    pub program_id: &'a [u8; 32],
    pub pool: &'a [u8; 32],
    pub genesis_hash: &'a [u8; 32],
    pub mint: &'a [u8; 32],
    pub destination_token_account: &'a [u8; 32],
    pub destination_owner: &'a [u8; 32],
    pub payout_amount: u64,
    pub relayer_fee: u64,
    pub relayer: Option<&'a [u8; 32]>,
    pub relayer_fee_token_account: Option<&'a [u8; 32]>,
    pub valid_until_slot: u64,
}

pub fn intent_bytes(i: &IntentFields) -> [u8; INTENT_BYTES_LEN] {
    const ZERO: [u8; 32] = [0u8; 32];
    let mut out = [0u8; INTENT_BYTES_LEN];
    let parts: [&[u8]; 13] = [
        INTENT_DOMAIN,
        i.program_id,
        i.pool,
        i.genesis_hash,
        i.mint,
        i.destination_token_account,
        i.destination_owner,
        &i.payout_amount.to_be_bytes(),
        &i.relayer_fee.to_be_bytes(),
        &[i.relayer.is_some() as u8],
        i.relayer.unwrap_or(&ZERO),
        i.relayer_fee_token_account.unwrap_or(&ZERO),
        &i.valid_until_slot.to_be_bytes(),
    ];
    let mut at = 0;
    for p in parts {
        out[at..at + p.len()].copy_from_slice(p);
        at += p.len();
    }
    debug_assert_eq!(at, INTENT_BYTES_LEN);
    out
}

/// The spend circuit's `context` public input.
pub fn intent_context(i: &IntentFields) -> [u8; 32] {
    sha256_first31(&[&intent_bytes(i)])
}

/// payout + fee as a checked u64 (the spend circuit's `withdrawnValue`).
pub fn withdrawn_value(i: &IntentFields) -> Option<u64> {
    i.payout_amount.checked_add(i.relayer_fee)
}

pub const MAX_INTENT_SLOTS: u64 = 750;

/// Intent rule violations, named after the program error codes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntentRuleError {
    PayoutZero,
    AmountOverflow,
    RelayerFeeNotAllowed,
    RelayerFeeAccountMismatch,
    IntentExpired,
    IntentTooFarInFuture,
}

/// Intent rules 1, 2, the structural part of 3, 4 and 5. Returns the withdrawn value.
/// The relayer signer and fee-account ownership checks of rule 3 need accounts and stay in the program.
pub fn check_intent(i: &IntentFields, max_relayer_fee: u64, current_slot: u64) -> Result<u64, IntentRuleError> {
    if i.payout_amount == 0 {
        return Err(IntentRuleError::PayoutZero);
    }
    let withdrawn = withdrawn_value(i).ok_or(IntentRuleError::AmountOverflow)?;
    match i.relayer {
        None if i.relayer_fee != 0 => return Err(IntentRuleError::RelayerFeeNotAllowed),
        None if i.relayer_fee_token_account.is_some() => return Err(IntentRuleError::RelayerFeeAccountMismatch),
        Some(_) if (i.relayer_fee > 0) != i.relayer_fee_token_account.is_some() => {
            return Err(IntentRuleError::RelayerFeeAccountMismatch)
        }
        _ => {}
    }
    if i.relayer_fee > max_relayer_fee {
        return Err(IntentRuleError::RelayerFeeNotAllowed);
    }
    if current_slot > i.valid_until_slot {
        return Err(IntentRuleError::IntentExpired);
    }
    if i.valid_until_slot - current_slot > MAX_INTENT_SLOTS {
        return Err(IntentRuleError::IntentTooFarInFuture);
    }
    Ok(withdrawn)
}

/// Deposit leaf H3(amount, label, precommitment). Inputs must already be canonical; the
/// Poseidon implementation rejects values >= r.
pub fn deposit_commitment(
    amount: u64,
    label: &[u8; 32],
    precommitment: &[u8; 32],
) -> Result<[u8; 32], PoseidonSyscallError> {
    let amount = u64_to_field(amount);
    solana_poseidon::hashv(
        Parameters::Bn254X5,
        Endianness::BigEndian,
        &[&amount, label, precommitment],
    )
    .map(|h| h.to_bytes())
}

/// groth16-solana proof encoding: `a` is the negated A point.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Groth16Proof {
    pub a: [u8; 64],
    pub b: [u8; 128],
    pub c: [u8; 64],
}

fn verify<const N: usize>(
    proof: &Groth16Proof,
    public_inputs: &[[u8; 32]; N],
    key: &groth16_solana::groth16::Groth16Verifyingkey,
) -> Result<(), Groth16Error> {
    // verify() (not verify_unchecked) rejects public inputs >= r.
    Groth16Verifier::new(&proof.a, &proof.b, &proof.c, public_inputs, key)?.verify()
}

/// Inputs: context, stateRoot, approvedRoot, nullifierHash, withdrawnValue, newCommitment.
pub fn verify_spend(proof: &Groth16Proof, public_inputs: &[[u8; 32]; vk::SPEND_NR_INPUTS]) -> Result<(), Groth16Error> {
    verify(proof, public_inputs, &vk::SPEND_VK)
}

/// Inputs: oldRoot, newRoot, leafIndex, leaf.
pub fn verify_insert(proof: &Groth16Proof, public_inputs: &[[u8; 32]; vk::INSERT_NR_INPUTS]) -> Result<(), Groth16Error> {
    verify(proof, public_inputs, &vk::INSERT_VK)
}

/// Inputs: stateRoot, label, value, nullifierHash.
pub fn verify_exit(proof: &Groth16Proof, public_inputs: &[[u8; 32]; vk::EXIT_NR_INPUTS]) -> Result<(), Groth16Error> {
    verify(proof, public_inputs, &vk::EXIT_VK)
}
