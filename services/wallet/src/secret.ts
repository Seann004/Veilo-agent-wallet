import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const FILE_PREFIX = "veilo-owner-service-secret-v1:";
export const KEY_VERSION = 1;

export class SecretError extends Error {
  override readonly name = "SecretError";
}

/** Owner-only file access: POSIX mode bits, or an ACL granting only the current user on Windows. */
export function restrictToOwner(path: string, isDir: boolean): boolean {
  if (process.platform !== "win32") {
    chmodSync(path, isDir ? 0o700 : 0o600);
    return true;
  }
  const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
  if (!user) return false;
  const grant = isDir ? `${user}:(OI)(CI)F` : `${user}:F`;
  return spawnSync("icacls", [path, "/inheritance:r", "/grant:r", grant], { encoding: "utf8" }).status === 0;
}

/**
 * Creates the owner service secret (32 random bytes) if absent. Returns whether a file was
 * created. The contents are never returned or printed.
 */
export function ensureOwnerServiceSecret(path: string): { created: boolean; restricted: boolean } {
  if (existsSync(path)) return { created: false, restricted: true };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${FILE_PREFIX}${randomBytes(32).toString("base64url")}\n`, { flag: "wx", mode: 0o600 });
  return { created: true, restricted: restrictToOwner(path, false) };
}

/**
 * Keys derived from the owner service secret. The object refuses to serialize so a stray log
 * or JSON response cannot carry key bytes.
 */
export class WalletKeys {
  readonly #aead: Buffer;
  readonly #noteSeed: Uint8Array;
  readonly #backup: Buffer;

  constructor(root: Uint8Array) {
    if (root.length !== 32) throw new SecretError("owner service secret must be 32 bytes");
    const derive = (info: string) => Buffer.from(hkdfSync("sha256", root, new Uint8Array(0), Buffer.from(info, "ascii"), 32));
    this.#aead = derive("veilo/wallet/aead/v1");
    this.#noteSeed = new Uint8Array(derive("veilo/wallet/note-seed/v1"));
    this.#backup = derive("veilo/wallet/backup/v1");
  }

  static fromFile(path: string): WalletKeys {
    if (!existsSync(path)) throw new SecretError("OWNER_SERVICE_SECRET_PATH file is missing; run pnpm setup:local");
    const text = readFileSync(path, "utf8").trim();
    if (!text.startsWith(FILE_PREFIX)) throw new SecretError("owner service secret file has an unknown format");
    const root = Buffer.from(text.slice(FILE_PREFIX.length), "base64url");
    if (root.length !== 32) throw new SecretError("owner service secret file is malformed");
    return new WalletKeys(root);
  }

  /** IKM for protocol HKDF note/salt/one-time derivations (protocol section 3.4). */
  get noteSeed(): Uint8Array {
    return this.#noteSeed;
  }

  seal(plaintext: Uint8Array, aad: string): { ciphertext: Buffer; nonce: Buffer } {
    return seal(this.#aead, plaintext, aad);
  }

  open(ciphertext: Uint8Array, nonce: Uint8Array, aad: string): Buffer {
    return open(this.#aead, ciphertext, nonce, aad);
  }

  sealBackup(plaintext: Uint8Array, aad: string): { ciphertext: Buffer; nonce: Buffer } {
    return seal(this.#backup, plaintext, aad);
  }

  openBackup(ciphertext: Uint8Array, nonce: Uint8Array, aad: string): Buffer {
    return open(this.#backup, ciphertext, nonce, aad);
  }

  toJSON(): string {
    return "[WalletKeys redacted]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[WalletKeys redacted]";
  }
}

const TAG = 16;

/** AES-256-GCM; output is ciphertext || tag. The AAD binds a ciphertext to its row and purpose. */
function seal(key: Buffer, plaintext: Uint8Array, aad: string): { ciphertext: Buffer; nonce: Buffer } {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  return { ciphertext: Buffer.concat([body, c.getAuthTag()]), nonce };
}

function open(key: Buffer, ciphertext: Uint8Array, nonce: Uint8Array, aad: string): Buffer {
  if (nonce.length !== 12 || ciphertext.length < TAG) throw new SecretError("ciphertext is malformed");
  const buf = Buffer.from(ciphertext);
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce));
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(buf.subarray(buf.length - TAG));
  try {
    return Buffer.concat([d.update(buf.subarray(0, buf.length - TAG)), d.final()]);
  } catch {
    throw new SecretError("ciphertext failed authentication (wrong key or tampered data)");
  }
}
