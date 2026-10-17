import { existsSync, readFileSync } from "node:fs";
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairFromBytes,
  createTransactionMessage,
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
  type Transaction,
} from "@solana/kit";

/** Fee/rent sponsor and relayer signer. Key bytes stay inside the CryptoKeyPair. */
export interface SponsorKey {
  address: Address;
  keyPair: Awaited<ReturnType<typeof createKeyPairFromBytes>>;
}

export class SponsorKeyError extends Error {
  override readonly name = "SponsorKeyError";
}

/** Loads a Solana CLI keypair file (JSON array of 64 bytes). Contents are never printed. */
export async function loadSponsorKey(path: string | undefined): Promise<SponsorKey | null> {
  if (path === undefined) return null;
  if (!existsSync(path)) throw new SponsorKeyError("SPONSOR_KEY_PATH file is missing");
  let bytes: Uint8Array;
  try {
    const arr = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(arr) || arr.length !== 64 || !arr.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) throw new Error();
    bytes = Uint8Array.from(arr as number[]);
  } catch {
    throw new SponsorKeyError("SPONSOR_KEY_PATH is not a 64-byte keypair file");
  }
  const keyPair = await createKeyPairFromBytes(bytes);
  bytes.fill(0);
  return { address: await getAddressFromPublicKey(keyPair.publicKey), keyPair };
}

export interface SignedTx {
  wire: string;
  signature: string;
  blockhash: string;
  lastValidBlockHeight: bigint;
}

export async function sponsorSignedTx(sponsor: SponsorKey, bh: { blockhash: string; lastValidBlockHeight: bigint }, ixs: Instruction[]): Promise<SignedTx> {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(sponsor.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: bh.blockhash as Blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  return finish(await partiallySignTransaction([sponsor.keyPair], compileTransaction(msg)), bh);
}

export async function sponsorCosign(sponsor: SponsorKey, tx: Transaction, bh: { blockhash: string; lastValidBlockHeight: bigint }): Promise<SignedTx> {
  return finish(await partiallySignTransaction([sponsor.keyPair], tx), bh);
}

function finish(tx: Transaction, bh: { blockhash: string; lastValidBlockHeight: bigint }): SignedTx {
  return { wire: getBase64EncodedWireTransaction(tx), signature: getSignatureFromTransaction(tx), blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight };
}
