import { address, type Address } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

/** Associated token account for `owner` and `mint` under the original SPL Token program. */
export async function deriveAta(owner: string, mint: string): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({
    owner: address(owner),
    mint: address(mint),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return ata;
}
