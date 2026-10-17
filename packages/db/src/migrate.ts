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

/** First line marker for migrations that rebuild a table referenced by foreign keys. */
export const TABLE_REBUILD_MARKER = "-- veilo:table-rebuild";
export const isTableRebuild = (sql: string): boolean => sql.trimStart().startsWith(TABLE_REBUILD_MARKER);

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
    const rebuild = isTableRebuild(m.sql);
    // SQLite's table-rebuild procedure: enforcement off outside the transaction, a full
    // foreign_key_check before commit, enforcement restored afterwards.
    if (rebuild) db.pragma("foreign_keys = OFF");
    const apply = db.transaction(() => {
      db.exec(m.sql);
      if (rebuild) {
        const violations = db.pragma("foreign_key_check") as unknown[];
        if (violations.length > 0) throw new MigrationError(`migration ${m.version} (${m.name}) leaves ${violations.length} foreign key violation(s)`);
      }
      db.prepare("INSERT INTO schema_migration (version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)").run(
        m.version,
        m.name,
        checksum(m.sql),
        Date.now(),
      );
      db.prepare("INSERT OR IGNORE INTO veilo_meta (key, value) VALUES ('db_role', ?)").run(role);
    });
    try {
      apply.immediate();
    } finally {
      if (rebuild) db.pragma("foreign_keys = ON");
    }
    newlyApplied.push(m.version);
  }
  return newlyApplied;
}
