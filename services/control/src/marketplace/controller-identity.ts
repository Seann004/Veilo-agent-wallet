import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { getAddressDecoder, getBase58Decoder } from "@solana/kit";
import { controllerRegistrationMessage } from "@veilo/contracts/marketplace";
import { readSecretFile, writeSecretFileOnce } from "./secret-files";

/**
 * This control service's Ed25519 marketplace identity. The private key is a PKCS#8 PEM in a
 * 0600 file under the control secrets directory; only the public key, key ID and signatures
 * ever leave this object.
 */
export class ControllerIdentity {
  readonly publicKey: string;
  readonly keyId: string;
  readonly #key: KeyObject;

  private constructor(key: KeyObject) {
    this.#key = key;
    const raw = Buffer.from(createPublicKey(key).export({ format: "jwk" }).x as string, "base64url");
    this.publicKey = getAddressDecoder().decode(raw);
    this.keyId = `ctl_${createHash("sha256").update(raw).digest("base64url").slice(0, 24)}`;
  }

  /** Loads the key at `path`, generating it on first use. */
  static loadOrCreate(path: string): ControllerIdentity {
    let pem = readSecretFile(path);
    if (pem === undefined) {
      const { privateKey } = generateKeyPairSync("ed25519");
      try {
        writeSecretFileOnce(path, privateKey.export({ format: "pem", type: "pkcs8" }) as string);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      pem = readSecretFile(path) as string;
    }
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("controller key must be Ed25519");
    return new ControllerIdentity(key);
  }

  /** Base58 Ed25519 signature over the UTF-8 message. */
  sign(message: string): string {
    return getBase58Decoder().decode(sign(null, Buffer.from(message, "utf8"), this.#key));
  }

  registration(workspaceId: string, userId: string): { controllerKey: string; keyId: string; proof: string } {
    return {
      controllerKey: this.publicKey,
      keyId: this.keyId,
      proof: this.sign(controllerRegistrationMessage(workspaceId, userId, this.publicKey, this.keyId)),
    };
  }
}
