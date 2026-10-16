import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type RelayerDb = Database.Database;

/**
 * Relayer state: withdrawals hold only public proof material. Every transaction's blockhash,
 * last-valid height and signature are written before it is sent. Sponsor lamports are an
 * append-only ledger with fees, outstanding rent and recovered rent kept separate.
 */
const MIGRATIONS: ReadonlyArray<{ version: number; sql: string; rebuild?: true }> = [
  {
    version: 1,
    sql: `
CREATE TABLE withdrawal (
  id TEXT PRIMARY KEY,
  nullifier_hash TEXT NOT NULL UNIQUE,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  destination_owner TEXT NOT NULL,
  destination_ata TEXT NOT NULL,
  valid_until_slot INTEGER NOT NULL,
  sponsor_cap INTEGER NOT NULL CHECK (sponsor_cap >= 0),
  state TEXT NOT NULL CHECK (state IN ('accepted', 'ata_submitted', 'submitted', 'finalized', 'failed', 'expired', 'rejected')),
  ata_signature TEXT UNIQUE,
  ata_blockhash TEXT,
  ata_last_valid_block_height INTEGER,
  signature TEXT UNIQUE,
  blockhash TEXT,
  last_valid_block_height INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  finalized_slot INTEGER,
  error TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE withdrawal_attempt (
  withdrawal_id TEXT NOT NULL REFERENCES withdrawal(id),
  leg TEXT NOT NULL CHECK (leg IN ('ata', 'spend')),
  attempt_no INTEGER NOT NULL,
  signature TEXT NOT NULL UNIQUE,
  blockhash TEXT NOT NULL,
  last_valid_block_height INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (withdrawal_id, leg, attempt_no)
) STRICT;

CREATE TRIGGER withdrawal_attempt_immutable BEFORE UPDATE ON withdrawal_attempt
BEGIN SELECT RAISE(ABORT, 'attempts are immutable'); END;

CREATE TABLE recovery (
  id TEXT PRIMARY KEY,
  fresh_wallet TEXT NOT NULL,
  destination_ata TEXT NOT NULL,
  amount INTEGER NOT NULL,
  signature TEXT NOT NULL UNIQUE,
  blockhash TEXT NOT NULL,
  last_valid_block_height INTEGER NOT NULL,
  rent_lamports INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('submitted', 'finalized', 'failed', 'expired')),
  fee_lamports INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE crank_attempt (
  id TEXT PRIMARY KEY,
  queue_seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('insert', 'skip')),
  signature TEXT NOT NULL UNIQUE,
  blockhash TEXT NOT NULL,
  last_valid_block_height INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('submitted', 'finalized', 'failed', 'expired')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE sponsor_event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('fee_spent', 'rent_outstanding', 'rent_recovered')),
  ref TEXT NOT NULL,
  signature TEXT NOT NULL,
  lamports INTEGER NOT NULL CHECK (lamports >= 0),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (kind, signature)
) STRICT;

CREATE TRIGGER sponsor_event_no_update BEFORE UPDATE ON sponsor_event
BEGIN SELECT RAISE(ABORT, 'sponsor events are append-only'); END;
CREATE TRIGGER sponsor_event_no_delete BEFORE DELETE ON sponsor_event
BEGIN SELECT RAISE(ABORT, 'sponsor events are append-only'); END;

CREATE TABLE indexed_tx (
  signature TEXT PRIMARY KEY,
  slot INTEGER NOT NULL,
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  logs_json TEXT NOT NULL CHECK (json_valid(logs_json))
) STRICT;
`,
  },
  {
    // A withdrawal is recorded before any chain read (checked_at_ms stays NULL until the
    // chain checks pass), and a nullifier may have a new request once every earlier request
    // for it ended expired, rejected or failed. The program still allows one spend only.
    version: 2,
    rebuild: true,
    sql: `
CREATE TABLE withdrawal_new (
  id TEXT PRIMARY KEY,
  nullifier_hash TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  destination_owner TEXT NOT NULL,
  destination_ata TEXT NOT NULL,
  valid_until_slot INTEGER NOT NULL,
  sponsor_cap INTEGER NOT NULL CHECK (sponsor_cap >= 0),
  state TEXT NOT NULL CHECK (state IN ('accepted', 'ata_submitted', 'submitted', 'finalized', 'failed', 'expired', 'rejected')),
  checked_at_ms INTEGER,
  ata_signature TEXT UNIQUE,
  ata_blockhash TEXT,
  ata_last_valid_block_height INTEGER,
  signature TEXT UNIQUE,
  blockhash TEXT,
  last_valid_block_height INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  finalized_slot INTEGER,
  error TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

INSERT INTO withdrawal_new (id, nullifier_hash, request_json, destination_owner, destination_ata, valid_until_slot, sponsor_cap, state, checked_at_ms,
  ata_signature, ata_blockhash, ata_last_valid_block_height, signature, blockhash, last_valid_block_height, attempts, finalized_slot, error, created_at_ms, updated_at_ms)
SELECT id, nullifier_hash, request_json, destination_owner, destination_ata, valid_until_slot, sponsor_cap, state, created_at_ms,
  ata_signature, ata_blockhash, ata_last_valid_block_height, signature, blockhash, last_valid_block_height, attempts, finalized_slot, error, created_at_ms, updated_at_ms
FROM withdrawal;

DROP TABLE withdrawal;
ALTER TABLE withdrawal_new RENAME TO withdrawal;

CREATE UNIQUE INDEX withdrawal_one_live_per_nullifier ON withdrawal (nullifier_hash) WHERE state NOT IN ('expired', 'rejected', 'failed');
`,
  },
];

export function openRelayerDb(path: string): RelayerDb {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.defaultSafeIntegers(true);
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)");
  const applied = new Set((db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: bigint }>).map((r) => Number(r.version)));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    // Table rebuilds follow SQLite's procedure: foreign keys off outside the transaction and a
    // full foreign_key_check before commit.
    if (m.rebuild) db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(m.sql);
        if (m.rebuild && (db.pragma("foreign_key_check") as unknown[]).length > 0) throw new Error(`relayer migration ${m.version} leaves foreign key violations`);
        db.prepare("INSERT INTO schema_migrations (version, applied_at_ms) VALUES (?, ?)").run(m.version, Date.now());
      }).immediate();
    } finally {
      if (m.rebuild) db.pragma("foreign_keys = ON");
    }
  }
  return db;
}

export interface SponsorTotals {
  feesSpent: bigint;
  rentOutstanding: bigint;
  rentRecovered: bigint;
}

/** Sponsor exposure = fees spent + rent not yet recovered; recovered rent is not negative fee. */
export function sponsorTotals(db: RelayerDb): SponsorTotals {
  const sum = (kind: string) => (db.prepare(`SELECT ifnull(sum(lamports), 0) FROM sponsor_event WHERE kind = ?`).pluck().get(kind) as bigint) ?? 0n;
  const outstanding = sum("rent_outstanding") - sum("rent_recovered");
  return { feesSpent: sum("fee_spent"), rentOutstanding: outstanding < 0n ? 0n : outstanding, rentRecovered: sum("rent_recovered") };
}

export function recordSponsorEvent(db: RelayerDb, kind: "fee_spent" | "rent_outstanding" | "rent_recovered", ref: string, signature: string, lamports: bigint): void {
  db.prepare(`INSERT OR IGNORE INTO sponsor_event (kind, ref, signature, lamports, created_at_ms) VALUES (?, ?, ?, ?, ?)`).run(kind, ref, signature, lamports, Date.now());
}
