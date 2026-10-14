import Database from "better-sqlite3";

export type SqliteDatabase = Database.Database;

/** Opens a SQLite database in WAL mode with foreign keys enforced. */
export function openSqlite(path: string): SqliteDatabase {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}
