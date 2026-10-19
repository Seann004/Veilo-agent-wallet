import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createKeyPairSignerFromPrivateKeyBytes, signBytes, type KeyPairSigner } from "@solana/kit";
import { createClient } from "@supabase/supabase-js";

/** A throwaway key kept as a 0600 seed file under `dir`; created on first use and never printed. */
export async function keyFor(dir: string, name: string): Promise<KeyPairSigner> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${name}.seed.json`);
  if (!existsSync(path)) writeFileSync(path, JSON.stringify([...randomBytes(32)]), { mode: 0o600 });
  chmodSync(path, 0o600);
  const seed = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]);
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  seed.fill(0);
  return signer;
}

export const signText = async (signer: KeyPairSigner, message: string) => new Uint8Array(await signBytes(signer.keyPair.privateKey, new TextEncoder().encode(message)));

/** A marketplace session for `signer` through Supabase Web3 sign-in. */
export async function web3Session(signer: KeyPairSigner): Promise<{ token: string; userId: string }> {
  const client = createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_PUBLISHABLE_KEY as string, { auth: { persistSession: false, autoRefreshToken: false } });
  const message = [
    "localhost:3000 wants you to sign in with your Solana account:",
    signer.address,
    "",
    "Sign in to Veilo marketplace. This is a login message, not a transaction or spending approval.",
    "",
    "Version: 1",
    "URI: http://localhost:3000/marketplace",
    `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
  const { data, error } = await client.auth.signInWithWeb3({ chain: "solana", message, signature: await signText(signer, message) });
  if (error || !data.session) throw new Error(`web3 sign-in failed: ${error?.message ?? "no session"}`);
  return { token: data.session.access_token, userId: data.session.user.id };
}
