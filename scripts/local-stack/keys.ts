// Throwaway keypair files for the local test validator stack. Files are created once with
// owner-only permissions and never overwritten; only public keys are ever printed.
import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getBase58Decoder } from "@solana/kit";
import { restrictToOwner } from "../../services/wallet/src/secret";
import { publicKeyOfKeyFile } from "../devnet/lib";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function ensureKeypairFile(path: string): string {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const d = Buffer.from(privateKey.export({ format: "jwk" }).d ?? "", "base64url");
    const x = Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url");
    const bytes = [...d, ...x];
    d.fill(0);
    writeFileSync(path, `${JSON.stringify(bytes)}\n`, { flag: "wx", mode: 0o600 });
    bytes.fill(0);
    restrictToOwner(path, false);
  }
  return publicKeyOfKeyFile(path);
}

/** Random bearer credential file (created once). */
export function ensureTokenFile(path: string, prefix: string): void {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${prefix}_${randomBytes(32).toString("base64url")}\n`, { flag: "wx", mode: 0o600 });
  restrictToOwner(path, false);
}

/** Signs a UTF-8 message (owner session challenge) with a Solana keypair file; returns base58. */
export function signTextWithKeyFile(path: string, message: string): string {
  const arr = JSON.parse(readFileSync(path, "utf8")) as number[];
  const seed = Buffer.from(arr.slice(0, 32));
  try {
    const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
    return getBase58Decoder().decode(sign(null, Buffer.from(message, "utf8"), key));
  } finally {
    seed.fill(0);
    arr.fill(0);
  }
}
