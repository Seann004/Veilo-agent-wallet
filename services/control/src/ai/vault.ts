import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const PREFIX = "veilo-ai-provider-key-v1:";

/**
 * Seals the owner's model API key with AES-256-GCM under a 32-byte key file kept in the control
 * secrets directory (created 0600 on first use). Ciphertext is bound to its workspace by the AAD,
 * so a row copied to another workspace does not decrypt. The key never appears in logs or JSON.
 */
export class ProviderKeyVault {
  readonly #key: Buffer;

  private constructor(key: Buffer) {
    this.#key = key;
  }

  static fromFile(path: string): ProviderKeyVault {
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${PREFIX}${randomBytes(32).toString("base64")}\n`, { mode: 0o600 });
    }
    chmodSync(path, 0o600);
    const raw = readFileSync(path, "utf8").trim();
    if (!raw.startsWith(PREFIX)) throw new Error("AI provider key file has an unexpected format");
    const key = Buffer.from(raw.slice(PREFIX.length), "base64");
    if (key.length !== 32) throw new Error("AI provider key file must hold 32 bytes");
    return new ProviderKeyVault(key);
  }

  /** For tests: a vault with an in-memory key. */
  static ephemeral(): ProviderKeyVault {
    return new ProviderKeyVault(randomBytes(32));
  }

  /** `purpose` is bound into the AAD, so a sealed secret only opens for the use it was stored for. */
  seal(workspaceId: string, apiKey: string, purpose = "ai-provider"): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(Buffer.from(`workspace:${workspaceId}:${purpose}`));
    const body = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return `${nonce.toString("base64")}.${body.toString("base64")}`;
  }

  open(workspaceId: string, sealed: string, purpose = "ai-provider"): string {
    const [n, b] = sealed.split(".");
    if (!n || !b) throw new Error("sealed provider key is malformed");
    const nonce = Buffer.from(n, "base64");
    const body = Buffer.from(b, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce);
    decipher.setAAD(Buffer.from(`workspace:${workspaceId}:${purpose}`));
    decipher.setAuthTag(body.subarray(body.length - 16));
    return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString("utf8");
  }

  toJSON(): string {
    return "[ProviderKeyVault]";
  }
}
