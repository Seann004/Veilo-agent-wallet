//! Minimal program that runs one Groth16 verification per instruction, used only to measure
//! verifier compute units. Instruction data: circuit (0 spend, 1 insert, 2 exit) || a || b || c || inputs.

use solana_account_info::AccountInfo;
use solana_program_error::{ProgramError, ProgramResult};
use solana_pubkey::Pubkey;
use veilo_crypto::{verify_exit, verify_insert, verify_spend, Groth16Proof};

#[cfg(not(feature = "no-entrypoint"))]
solana_program_entrypoint::entrypoint!(process_instruction);

fn inputs<const N: usize>(data: &[u8]) -> Result<[[u8; 32]; N], ProgramError> {
    if data.len() != 32 * N {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut out = [[0u8; 32]; N];
    for (i, chunk) in data.chunks_exact(32).enumerate() {
        out[i].copy_from_slice(chunk);
    }
    Ok(out)
}

pub fn process_instruction(_program_id: &Pubkey, _accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 257 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut proof = Groth16Proof { a: [0; 64], b: [0; 128], c: [0; 64] };
    proof.a.copy_from_slice(&data[1..65]);
    proof.b.copy_from_slice(&data[65..193]);
    proof.c.copy_from_slice(&data[193..257]);
    let rest = &data[257..];
    let result = match data[0] {
        0 => verify_spend(&proof, &inputs(rest)?),
        1 => verify_insert(&proof, &inputs(rest)?),
        2 => verify_exit(&proof, &inputs(rest)?),
        _ => return Err(ProgramError::InvalidInstructionData),
    };
    result.map_err(|_| ProgramError::Custom(1))
}
