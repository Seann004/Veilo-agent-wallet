import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

const checksum = (sql: string) => createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex");

/**
 * Applies pending migrations in version order, each in its own IMMEDIATE transaction.
 * Already-applied migrations must keep their recorded checksum; an edited or missing
 * migration stops startup instead of silently diverging.
 */
export function runMigrations(db: Database.Database, migrations: readonly Migration[], role: string): number[] {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  ordered.forEach((m, i) => {
    if (m.version !== i + 1) throw new MigrationError(`migrations must be numbered contiguously from 1 (got ${m.version})`);
  });

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS veilo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`);

  const existingRole = db.prepare("SELECT value FROM veilo_meta WHERE key = 'db_role'").pluck().get() as
    | string
    | undefined;
  if (existingRole !== undefined && existingRole !== role) {
    throw new MigrationError(`database role is "${existingRole}", refusing to open it as "${role}"`);
  }

  const applied = new Map<number, string>();
  for (const row of db.prepare("SELECT version, checksum FROM schema_migration").all() as Array<{
    version: number | bigint;
    checksum: string;
  }>) {
    applied.set(Number(row.version), row.checksum);
  }
  for (const [version, sum] of applied) {
    const m = ordered.find((x) => x.version === version);
    if (!m) throw new MigrationError(`database has migration ${version} unknown to this build`);
    if (checksum(m.sql) !== sum) throw new MigrationError(`migration ${version} (${m.name}) was modified after being applied`);
  }

  const newlyApplied: number[] = [];
  for (const m of ordered) {
    if (applied.has(m.version)) continue;
    const apply = db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migration (version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)").run(
        m.version,
        m.name,
        checksum(m.sql),
        Date.now(),
      );
      db.prepare("INSERT OR IGNORE INTO veilo_meta (key, value) VALUES ('db_role', ?)").run(role);
    });
    apply.immediate();
    newlyApplied.push(m.version);
  }
  return newlyApplied;
}
