import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { openControlDatabase, openSecretsDatabase } from "@veilo/db";
import { RESTORE_COUNTER_JUMP, RESTORE_FLAG, type RestoreScan } from "./reconcile";
import { restrictToOwner, SecretError, type WalletKeys } from "./secret";
import { WalletStore } from "./store";

const MAGIC = Buffer.from("VEILOBK1", "ascii");
const AAD = "veilo-backup-v1";

export interface BackupFileEntry {
  name: "wallet-secrets.sqlite" | "control.sqlite";
  sha256: string;
  size: number;
}

export interface BackupManifest {
  format: "veilo-backup-v1";
  createdAt: string;
  counters: { note: number; onetime: number };
  files: BackupFileEntry[];
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Consistent online snapshot through SQLite's backup API (safe while the service writes in WAL mode). */
async function snapshot(srcPath: string, destPath: string): Promise<Buffer> {
  const src = new Database(srcPath, { readonly: true, fileMustExist: true });
  try {
    await src.backup(destPath);
  } finally {
    src.close();
  }
  return readFileSync(destPath);
}

/**
 * Writes an encrypted backup of the wallet secrets database and the control ledger. The
 * payload is AES-256-GCM under a key derived from the owner service secret, which must be kept
 * separately; the backup alone cannot be decrypted.
 */
export async function createBackup(o: { secretsDbPath: string; controlDbPath: string; outPath: string; keys: WalletKeys; now?: Date }): Promise<{ path: string; manifest: BackupManifest }> {
  const work = mkdtempSync(join(tmpdir(), "veilo-backup-"));
  try {
    const secrets = await snapshot(o.secretsDbPath, join(work, "s.sqlite"));
    const control = existsSync(o.controlDbPath) ? await snapshot(o.controlDbPath, join(work, "c.sqlite")) : null;
    const snap = new Database(join(work, "s.sqlite"), { readonly: true });
    snap.defaultSafeIntegers(true);
    const counters = { note: 0, onetime: 0 };
    for (const r of snap.prepare(`SELECT name, next_value FROM key_counter`).all() as Array<{ name: string; next_value: bigint }>) {
      if (r.name === "note" || r.name === "onetime") counters[r.name] = Number(r.next_value);
    }
    snap.close();
    const files: Array<{ entry: BackupFileEntry; bytes: Buffer }> = [
      { entry: { name: "wallet-secrets.sqlite", sha256: sha256(secrets), size: secrets.length }, bytes: secrets },
      ...(control ? [{ entry: { name: "control.sqlite" as const, sha256: sha256(control), size: control.length }, bytes: control }] : []),
    ];
    const manifest: BackupManifest = { format: "veilo-backup-v1", createdAt: (o.now ?? new Date()).toISOString(), counters, files: files.map((f) => f.entry) };
    const header = Buffer.from(JSON.stringify(manifest), "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(header.length);
    const payload = Buffer.concat([len, header, ...files.map((f) => f.bytes)]);
    const { ciphertext, nonce } = o.keys.sealBackup(payload, AAD);
    mkdirSync(dirname(o.outPath), { recursive: true });
    writeFileSync(o.outPath, Buffer.concat([MAGIC, nonce, ciphertext]), { flag: "wx", mode: 0o600 });
    restrictToOwner(o.outPath, false);
    return { path: o.outPath, manifest };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export class BackupError extends Error {
  override readonly name = "BackupError";
}

/** Decrypts and validates a backup file; returns the manifest and file bytes. */
export function readBackup(path: string, keys: WalletKeys): { manifest: BackupManifest; files: Map<string, Buffer> } {
  const raw = readFileSync(path);
  if (raw.length < MAGIC.length + 12 + 16 || !raw.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupError("not a Veilo backup file");
  let payload: Buffer;
  try {
    payload = keys.openBackup(raw.subarray(MAGIC.length + 12), raw.subarray(MAGIC.length, MAGIC.length + 12), AAD);
  } catch (error) {
    if (error instanceof SecretError) throw new BackupError("backup failed authentication (different owner service secret or modified file)");
    throw error;
  }
  const headerLen = payload.readUInt32BE(0);
  const manifest = JSON.parse(payload.subarray(4, 4 + headerLen).toString("utf8")) as BackupManifest;
  if (manifest.format !== "veilo-backup-v1") throw new BackupError("unsupported backup format");
  const files = new Map<string, Buffer>();
  let off = 4 + headerLen;
  for (const f of manifest.files) {
    const bytes = payload.subarray(off, off + f.size);
    off += f.size;
    if (bytes.length !== f.size || sha256(bytes) !== f.sha256) throw new BackupError(`backup entry ${f.name} is corrupt`);
    files.set(f.name, Buffer.from(bytes));
  }
  if (off !== payload.length) throw new BackupError("backup has trailing data");
  return { manifest, files };
}

function moveAside(path: string, stamp: string): string | null {
  if (!existsSync(path)) return null;
  const aside = `${path}.pre-restore-${stamp}`;
  renameSync(path, aside);
  for (const suffix of ["-wal", "-shm"]) if (existsSync(path + suffix)) renameSync(path + suffix, aside + suffix);
  return aside;
}

export interface RestoreSummary {
  notes: number;
  freshWallets: number;
  fundingsPendingReconciliation: number;
  counters: { note: number; onetime: number };
  controlRestored: boolean;
  movedAside: string[];
}

/**
 * Restores the wallet secrets database (and the control ledger when it is missing or
 * `includeControl` is set). Every encrypted row is decrypted first to prove the key matches.
 * Key counters jump past any index that may have been used after the backup, and a blocking
 * flag stops new proofs and signatures until startup reconciliation has checked the chain.
 */
export function restoreBackup(o: { file: string; secretsDbPath: string; controlDbPath: string; keys: WalletKeys; includeControl?: boolean; now?: Date }): RestoreSummary {
  const { manifest, files } = readBackup(o.file, o.keys);
  const secrets = files.get("wallet-secrets.sqlite");
  if (!secrets) throw new BackupError("backup lacks the wallet secrets database");
  const work = mkdtempSync(join(tmpdir(), "veilo-restore-"));
  const stamp = (o.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const moved: string[] = [];
  try {
    const candidate = join(work, "wallet-secrets.sqlite");
    writeFileSync(candidate, secrets);
    const check = openSecretsDatabase(candidate, { controlDatabasePath: o.controlDbPath });
    if ((check.prepare("PRAGMA integrity_check").pluck().get() as string) !== "ok") throw new BackupError("restored secrets database fails integrity check");
    const probe = new WalletStore(check, o.keys);
    const notes = probe.notes();
    const fresh = probe.freshWallets();
    for (const w of fresh) probe.freshWalletSeed(w.purchaseId);
    const pending = probe.fundings(["prepared", "released", "submitted"]).length;
    check.close();

    const asideS = moveAside(o.secretsDbPath, stamp);
    if (asideS) moved.push(asideS);
    mkdirSync(dirname(o.secretsDbPath), { recursive: true });
    writeFileSync(o.secretsDbPath, secrets, { mode: 0o600 });
    restrictToOwner(o.secretsDbPath, false);

    let controlRestored = false;
    const control = files.get("control.sqlite");
    if (control && (o.includeControl || !existsSync(o.controlDbPath))) {
      const asideC = moveAside(o.controlDbPath, stamp);
      if (asideC) moved.push(asideC);
      mkdirSync(dirname(o.controlDbPath), { recursive: true });
      writeFileSync(o.controlDbPath, control);
      openControlDatabase(o.controlDbPath).close();
      controlRestored = true;
    }

    const db = openSecretsDatabase(o.secretsDbPath, { controlDatabasePath: o.controlDbPath });
    const store = new WalletStore(db, o.keys);
    const scan: RestoreScan = {
      note: Math.max(manifest.counters.note, store.counter("note"), store.maxNoteKeyIndex() + 1),
      onetime: Math.max(manifest.counters.onetime, store.counter("onetime")),
      jump: RESTORE_COUNTER_JUMP,
    };
    store.raiseCounter("note", scan.note + scan.jump);
    store.raiseCounter("onetime", scan.onetime + scan.jump);
    store.setFlag(RESTORE_FLAG, JSON.stringify(scan));
    store.event("restore.completed", null, { createdAt: manifest.createdAt, scanFrom: scan });
    const counters = { note: store.counter("note"), onetime: store.counter("onetime") };
    db.close();
    return { notes: notes.length, freshWallets: fresh.length, fundingsPendingReconciliation: pending, counters, controlRestored, movedAside: moved };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
