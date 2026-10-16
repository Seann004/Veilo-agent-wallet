// Creates the separately labeled devnet role keypairs once. Existing files are never replaced;
// a missing or mismatched role stops the script. Only public keys are printed or recorded
// (artifacts/deployment/roles.devnet.json). No chain interaction.
//   pnpm keys:init
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { restrictToOwner } from "../../services/wallet/src/secret";
import { publicKeyOfKeyFile, REPO, ROLE_KEYS_DIR, ROLES, ROLES_PATH, type RoleName, type RolesFile } from "./lib";

function newSolanaKeypairFile(path: string): void {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const d = Buffer.from(privateKey.export({ format: "jwk" }).d ?? "", "base64url");
  const x = Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url");
  if (d.length !== 32 || x.length !== 32) throw new Error("ed25519 key generation returned an unexpected length");
  const bytes = [...d, ...x];
  d.fill(0);
  // wx: never overwrite an existing key file, even if two runs race.
  writeFileSync(path, `${JSON.stringify(bytes)}\n`, { flag: "wx", mode: 0o600 });
  bytes.fill(0);
  if (!restrictToOwner(path, false)) throw new Error(`could not restrict permissions of ${relative(REPO, path)}`);
}

function main(): void {
  mkdirSync(ROLE_KEYS_DIR, { recursive: true });
  restrictToOwner(ROLE_KEYS_DIR, true);
  const existing: RolesFile | null = existsSync(ROLES_PATH) ? (JSON.parse(readFileSync(ROLES_PATH, "utf8")) as RolesFile) : null;
  const roles = {} as RolesFile["roles"];
  const created: string[] = [];
  for (const [name, spec] of Object.entries(ROLES) as Array<[RoleName, (typeof ROLES)[RoleName]]>) {
    const path = join(ROLE_KEYS_DIR, spec.file);
    const rel = relative(REPO, path).split("\\").join("/");
    const recorded = existing?.roles[name];
    if (!existsSync(path)) {
      if (recorded) throw new Error(`role ${name} is recorded as ${recorded.publicKey} but ${rel} is missing; restore it from backup (refusing to regenerate a recorded role)`);
      newSolanaKeypairFile(path);
      created.push(name);
    }
    const publicKey = publicKeyOfKeyFile(path);
    if (recorded && recorded.publicKey !== publicKey) throw new Error(`role ${name}: ${rel} holds ${publicKey}, but roles.devnet.json records ${recorded.publicKey}; stopping`);
    roles[name] = { publicKey, keyPath: rel, purpose: spec.purpose };
  }
  const poolId = existing?.poolId ?? randomBytes(32).toString("hex");
  const out: RolesFile = {
    schema: "veilo-devnet-roles-v1",
    cluster: "devnet",
    note: "Public keys only. Keypair files live under work/keys/devnet (gitignored, owner-only). Synthetic test participants are labeled as such; role separation is not independent-user anonymity.",
    poolId,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    roles,
  };
  mkdirSync(dirname(ROLES_PATH), { recursive: true });
  writeFileSync(ROLES_PATH, `${JSON.stringify(out, null, 2)}\n`);
  for (const [name, r] of Object.entries(roles)) console.log(`${name.padEnd(20)} ${r.publicKey}  ${created.includes(name) ? "(created)" : "(existing)"}`);
  console.log(`pool id              ${poolId}`);
  console.log(`recorded ${relative(REPO, ROLES_PATH)}`);
}

try {
  main();
} catch (error) {
  console.error(`keys:init failed: ${(error as Error).message}`);
  process.exit(1);
}
