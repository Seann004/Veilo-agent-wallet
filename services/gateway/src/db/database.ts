import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS } from "./migrations";

export type GatewayDb = Database.Database;

/**
 * Opens the gateway's own SQLite database (WAL, foreign keys, 64-bit integers as bigint)
 * and applies pending migrations in one immediate transaction each.
 */
export function openGatewayDb(path: string): GatewayDb {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.defaultSafeIntegers(true);
  migrate(db);
  return db;
}

export function migrate(db: GatewayDb): number {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: bigint }>).map((r) => Number(r.version)),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
    }).immediate();
  }
  return schemaVersion(db);
}

export function schemaVersion(db: GatewayDb): number {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: bigint | null };
  return row.v === null ? 0 : Number(row.v);
}

/** Runs `fn` inside BEGIN IMMEDIATE so concurrent writers serialize on the database lock. */
export function immediate<T>(db: GatewayDb, fn: () => T): T {
  return db.transaction(fn).immediate();
}
