import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { runMigrations, type Migration } from "./migrate";

export { runMigrations, MigrationError, type Migration } from "./migrate";

export type SqliteDatabase = Database.Database;

export const CONTROL_DB_ROLE = "control";
export const SECRETS_DB_ROLE = "wallet_secrets";
export const SECRETS_DB_FILENAME = "wallet-secrets.sqlite";

/** Opens a SQLite database in WAL mode with foreign keys enforced. */
export function openSqlite(path: string): SqliteDatabase {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

/** Read-only connection for inspection and evidence tools; it never migrates or writes. */
export function openSqliteReadonly(path: string): SqliteDatabase {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  return db;
}

const MIGRATIONS_DIR =fileURLToPath(new URL("../migrations/", import.meta.url));

export function loadMigrations(set: "control" | "secrets"): Migration[] {
  const dir = join(MIGRATIONS_DIR, set);
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((file) => ({
      version: Number(file.slice(0, 4)),
      name: file.slice(5, -4),
      sql: readFileSync(join(dir, file), "utf8"),
    }));
}

export class DatabaseSeparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseSeparationError";
  }
}

const isWithin = (parent: string, child: string) => {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export interface OpenControlOptions {
  /** The control ledger must not live inside the wallet secrets directory. */
  secretsDir?: string;
}

/**
 * Opens the authoritative control ledger with 64-bit integers returned as bigint, so no
 * amount ever passes through a JavaScript float. Applies pending migrations.
 */
export function openControlDatabase(path: string, options: OpenControlOptions = {}): SqliteDatabase {
  if (options.secretsDir !== undefined && isWithin(options.secretsDir, path)) {
    throw new DatabaseSeparationError("control database must not be stored in the secrets directory");
  }
  const db = openSqlite(path);
  db.defaultSafeIntegers(true);
  try {
    runMigrations(db, loadMigrations("control"), CONTROL_DB_ROLE);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

export interface OpenSecretsOptions {
  controlDatabasePath: string;
}

/** Wallet-service only. Refuses to share a file with the control ledger. */
export function openSecretsDatabase(path: string, options: OpenSecretsOptions): SqliteDatabase {
  if (resolve(path) === resolve(options.controlDatabasePath)) {
    throw new DatabaseSeparationError("secrets database must be a separate file from the control database");
  }
  const db = openSqlite(path);
  db.defaultSafeIntegers(true);
  try {
    runMigrations(db, loadMigrations("secrets"), SECRETS_DB_ROLE);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

export function secretsDatabasePath(secretsDir: string): string {
  return join(secretsDir, SECRETS_DB_FILENAME);
}

/** Runs `fn` inside BEGIN IMMEDIATE so the write lock is taken before any read. */
export function immediate<T>(db: SqliteDatabase, fn: () => T): T {
  return db.transaction(fn).immediate();
}
