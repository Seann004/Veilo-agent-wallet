// pnpm backup [-- --out <file>]: encrypted snapshot of the wallet secrets DB and control ledger.
// pnpm restore -- --file <file> [--include-control]: validated restore with a key-counter jump.
import { join, resolve } from "node:path";
import { VeiloConfigError, findRepoRoot, loadConfig, loadDotEnv } from "@veilo/contracts";
import { secretsDatabasePath } from "@veilo/db";
import { BackupError, createBackup, restoreBackup } from "../backup";
import { SecretError, WalletKeys } from "../secret";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const rootDir = findRepoRoot();
  loadDotEnv({ rootDir });
  const config = loadConfig(process.env, { rootDir });
  if (config.paths.ownerServiceSecret === undefined) throw new VeiloConfigError("INVALID_CONFIG", "OWNER_SERVICE_SECRET_PATH is not configured");
  const keys = WalletKeys.fromFile(config.paths.ownerServiceSecret);
  const secretsDbPath = secretsDatabasePath(config.paths.secretsDir);
  if (mode === "backup") {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const out = resolve(arg("--out") ?? join(rootDir, "backups", `veilo-${stamp}.veilo-backup`));
    const { path, manifest } = await createBackup({ secretsDbPath, controlDbPath: config.paths.controlDatabase, outPath: out, keys });
    console.log(`backup written: ${path}`);
    console.log(`  files: ${manifest.files.map((f) => `${f.name} (${f.size} bytes, sha256 ${f.sha256.slice(0, 12)}…)`).join(", ")}`);
    console.log(`  counters at backup: note ${manifest.counters.note}, one-time ${manifest.counters.onetime}`);
    console.log("  keep OWNER_SERVICE_SECRET_PATH separately; the backup cannot be decrypted without it.");
    return;
  }
  if (mode === "restore") {
    const file = arg("--file");
    if (!file) throw new VeiloConfigError("INVALID_CONFIG", "usage: pnpm restore -- --file <encrypted-backup> [--include-control]");
    const s = restoreBackup({
      file: resolve(file),
      secretsDbPath,
      controlDbPath: config.paths.controlDatabase,
      keys,
      includeControl: process.argv.includes("--include-control"),
    });
    console.log(`restore complete: ${s.notes} note(s), ${s.freshWallets} fresh wallet key(s); control ledger ${s.controlRestored ? "restored" : "kept"}`);
    console.log(`  key counters advanced to note ${s.counters.note}, one-time ${s.counters.onetime} (no index is reused)`);
    console.log(`  ${s.fundingsPendingReconciliation} funding(s) need reconciliation; new proofs and signatures stay blocked until the wallet's startup reconciliation passes`);
    for (const m of s.movedAside) console.log(`  previous file kept at ${m}`);
    return;
  }
  throw new VeiloConfigError("INVALID_CONFIG", "mode must be backup or restore");
}

main().catch((error: unknown) => {
  if (error instanceof VeiloConfigError || error instanceof BackupError || error instanceof SecretError) {
    console.error(`${(error as Error).name}: ${(error as Error).message}`);
    process.exit(1);
  }
  console.error(`failed: ${(error as Error).name}: ${(error as Error).message}`);
  process.exit(1);
});
