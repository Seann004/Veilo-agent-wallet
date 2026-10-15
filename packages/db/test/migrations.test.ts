import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { paymentTransitionEdges } from "@veilo/contracts";
import {
  DatabaseSeparationError,
  MigrationError,
  loadMigrations,
  openControlDatabase,
  openSecretsDatabase,
  runMigrations,
  type SqliteDatabase,
} from "../src/index";

let dir: string;
const open: SqliteDatabase[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function control(): SqliteDatabase {
  dir = mkdtempSync(join(tmpdir(), "veilo-db-"));
  const db = openControlDatabase(join(dir, "control.sqlite"));
  open.push(db);
  return db;
}

const NOW = 1_760_000_000_000;

/** Minimal valid graph: workspace, agent, approved service and one reserved purchase. */
function fixture(db: SqliteDatabase) {
  db.prepare(`INSERT INTO workspace (id, owner_pubkey, network, mint, mint_decimals, created_at_ms, updated_at_ms) VALUES ('w', 'owner', 'net', 'mint', 6, ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO agent (id, workspace_id, name, role, status, created_at_ms, updated_at_ms) VALUES ('a', 'w', 'A', 'research', 'active', ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO approved_service (id, workspace_id, service_key, origin, network, mint, status, created_at_ms, updated_at_ms) VALUES ('s', 'w', 'k', 'o', 'net', 'mint', 'unbound', ?, ?)`).run(NOW, NOW);
  insertPurchase(db, "p", "op1", "key1");
}

function insertPurchase(db: SqliteDatabase, id: string, op: string, key: string, workspace = "w") {
  db.prepare(
    `INSERT INTO purchase (id, workspace_id, operation_id, idempotency_key, agent_id, service_id, sku, payment_path, request_digest,
       price_usdc, fee_cap_usdc, sponsor_lamports, usage_units, policy_snapshot_json, workspace_policy_version, agent_policy_version,
       agent_epoch, stop_epoch, authorization_state, funding_state, merchant_state, fulfilment_state, recovery_state, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, 'a', 's', 'sku', 'private_x402', ?, 100, 0, 0, 0, '{}', 1, 1, 0, 0, 'reserved', 'not_started', 'not_started',
       'not_started', 'none', ?, ?)`,
  ).run(id, workspace, op, key, "a".repeat(64), NOW, NOW);
}

describe("migration runner", () => {
  it("applies once, records checksums and is idempotent on reopen", () => {
    const db = control();
    const versions = db.prepare("SELECT version FROM schema_migration ORDER BY version").pluck().all().map(Number);
    expect(versions).toEqual(loadMigrations("control").map((m) => m.version));
    expect(runMigrations(db, loadMigrations("control"), "control")).toEqual([]);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(Number(db.pragma("foreign_keys", { simple: true }))).toBe(1);
    expect(Number(db.pragma("busy_timeout", { simple: true }))).toBe(5000);
  });

  it("refuses a modified applied migration", () => {
    const db = control();
    const tampered = loadMigrations("control").map((m) => (m.version === 1 ? { ...m, sql: `${m.sql}\n-- edited` } : m));
    expect(() => runMigrations(db, tampered, "control")).toThrow(MigrationError);
  });

  it("creates every ledger entity", () => {
    const db = control();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all();
    for (const t of [
      "workspace", "agent", "task", "approved_service", "service_sku", "policy", "job", "purchase", "reservation", "note",
      "chain_attempt", "artifact", "artifact_revision", "audit_event", "financial_event", "token_event", "outbox", "inbox",
      "owner_session_challenge", "owner_session", "worker_credential",
    ]) {
      expect(tables).toContain(t);
    }
    expect(tables).not.toContain("note_secret");
  });

  it("seeds exactly the shared payment transition set", () => {
    const db = control();
    const rows = db.prepare("SELECT field, from_state AS \"from\", to_state AS \"to\" FROM payment_transition").all() as Array<Record<string, string>>;
    const key = (e: { field: string; from: string; to: string }) => `${e.field}:${e.from}>${e.to}`;
    expect(rows.map((r) => key(r as never)).sort()).toEqual(paymentTransitionEdges().map(key).sort());
    for (const field of ["funding", "merchant", "fulfilment"]) {
      expect(rows.filter((r) => r.field === field && r.from === "uncertain").map((r) => r.to)).not.toContain("abandoned");
    }
  });
});

describe("secrets separation", () => {
  it("keeps wallet secrets in a separate file and refuses cross-opening", () => {
    dir = mkdtempSync(join(tmpdir(), "veilo-db-"));
    const controlPath = join(dir, "control.sqlite");
    const secretsPath = join(dir, "secrets", "..", "wallet-secrets.sqlite");
    open.push(openControlDatabase(controlPath));
    expect(() => openSecretsDatabase(controlPath, { controlDatabasePath: controlPath })).toThrow(DatabaseSeparationError);
    const secrets = openSecretsDatabase(secretsPath, { controlDatabasePath: controlPath });
    open.push(secrets);
    expect(secrets.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all()).toContain("note_secret");
    expect(() => openControlDatabase(secretsPath)).toThrow(/role is "wallet_secrets"/);
    expect(() => openControlDatabase(join(dir, "s", "c.sqlite"), { secretsDir: join(dir, "s") })).toThrow(DatabaseSeparationError);
  });
});

describe("ledger constraints", () => {
  it("makes operation IDs unique per workspace and logical keys unique per agent", () => {
    const db = control();
    fixture(db);
    expect(() => insertPurchase(db, "p2", "op1", "key2")).toThrow(/UNIQUE/);
    expect(() => insertPurchase(db, "p3", "op3", "key1")).toThrow(/UNIQUE/);
  });

  it("allows one reservation per purchase and one note reservation per purchase", () => {
    const db = control();
    fixture(db);
    const res = `INSERT INTO reservation (id, purchase_id, workspace_id, agent_id, reserved_usdc, reserved_lamports, reserved_usage_units, status, created_at_ms)
                 VALUES (?, 'p', 'w', 'a', 100, 0, 0, 'active', ?)`;
    db.prepare(res).run("r1", NOW);
    expect(() => db.prepare(res).run("r2", NOW)).toThrow(/UNIQUE/);
    const note = `INSERT INTO note (id, workspace_id, commitment, value, origin, state, reserved_purchase_id, created_at_ms, updated_at_ms)
                  VALUES (?, 'w', ?, 100, 'deposit', 'reserved', 'p', ?, ?)`;
    db.prepare(note).run("n1", "1".repeat(64), NOW, NOW);
    expect(() => db.prepare(note).run("n2", "2".repeat(64), NOW, NOW)).toThrow(/UNIQUE/);
    expect(() => db.prepare("UPDATE reservation SET reserved_usdc = 1").run()).toThrow(/immutable/);
  });

  it("keeps chain signatures and job trigger keys unique", () => {
    const db = control();
    fixture(db);
    const att = `INSERT INTO chain_attempt (id, purchase_id, leg, attempt_no, signature, observed_commitment, created_at_ms) VALUES (?, 'p', ?, 1, 'sig', 'unknown', ?)`;
    db.prepare(att).run("c1", "funding", NOW);
    expect(() => db.prepare(att).run("c2", "merchant", NOW)).toThrow(/UNIQUE/);
    const job = `INSERT INTO job (id, workspace_id, agent_id, kind, trigger_key, scheduled_at_ms, agent_epoch, state, created_at_ms, updated_at_ms)
                 VALUES (?, 'w', 'a', 'credit_check', 'trigger', ?, 0, 'queued', ?, ?)`;
    db.prepare(job).run("j1", NOW, NOW, NOW);
    expect(() => db.prepare(job).run("j2", NOW, NOW, NOW)).toThrow(/UNIQUE/);
    expect(() => db.prepare("UPDATE job SET state = 'leased', lease_owner = 'w', lease_expires_at_ms = 1 WHERE id = 'j1'").run()).toThrow(/increment version/);
  });

  it("rejects floats, negatives and text in amount columns", () => {
    const db = control();
    fixture(db);
    const ins = `INSERT INTO financial_event (event_id, workspace_id, purchase_id, kind, asset, amount, occurred_at_ms, recorded_at_ms)
                 VALUES (?, 'w', 'p', 'reservation_opened', 'usdc', ?, ?, ?)`;
    expect(() => db.prepare(ins).run("e1", 1.5, NOW, NOW)).toThrow();
    expect(() => db.prepare(ins).run("e2", -1, NOW, NOW)).toThrow(/CHECK/);
    expect(() => db.prepare(ins).run("e3", "100", NOW, NOW)).not.toThrow(); // STRICT coerces a canonical integer string
    expect(() => db.prepare(ins).run("e4", "1e3x", NOW, NOW)).toThrow();
    expect(() => db.prepare(ins).run("e5", 9223372036854775807n, NOW, NOW)).not.toThrow();
    expect(() => db.prepare("SELECT sum(amount) FROM financial_event").get()).toThrow(/overflow/);
  });

  it("enforces state transitions, immutable identity and append-only events", () => {
    const db = control();
    fixture(db);
    expect(() => db.prepare("UPDATE purchase SET funding_state = 'finalized' WHERE id = 'p'").run()).toThrow(/funding state transition/);
    db.prepare("UPDATE purchase SET funding_state = 'proof_prepared' WHERE id = 'p'").run();
    expect(() => db.prepare("UPDATE purchase SET price_usdc = 1 WHERE id = 'p'").run()).toThrow(/immutable/);
    db.prepare("UPDATE purchase SET settled_at_ms = 5 WHERE id = 'p'").run();
    expect(() => db.prepare("UPDATE purchase SET settled_at_ms = 6 WHERE id = 'p'").run()).toThrow(/immutable/);
    db.prepare(
      `INSERT INTO audit_event (event_id, scope, actor_type, action, policy_result, created_at_ms) VALUES ('x', 's', 'system', 'a', 'allowed', ?)`,
    ).run(NOW);
    expect(() => db.prepare("DELETE FROM audit_event").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM payment_transition").run()).toThrow(/fixed by migration/);
  });

  it("bounds expense adjustments by the linked principal", () => {
    const db = control();
    fixture(db);
    db.prepare(
      `INSERT INTO financial_event (event_id, workspace_id, purchase_id, kind, asset, amount, principal_amount, fee_amount, occurred_at_ms, recorded_at_ms)
       VALUES ('x', 'w', 'p', 'expense_settled', 'usdc', 110, 100, 10, ?, ?)`,
    ).run(NOW, NOW);
    const adj = `INSERT INTO financial_event (event_id, workspace_id, purchase_id, kind, asset, amount, linked_event_id, reason, occurred_at_ms, recorded_at_ms)
                 VALUES (?, 'w', 'p', 'expense_adjusted', 'usdc', ?, 'x', 'merchant_refund', ?, ?)`;
    db.prepare(adj).run("a1", 60, NOW, NOW);
    expect(() => db.prepare(adj).run("a2", 41, NOW, NOW)).toThrow(/principal/);
    db.prepare(adj).run("a3", 40, NOW, NOW);
    expect(() =>
      db.prepare(
        `INSERT INTO financial_event (event_id, workspace_id, purchase_id, kind, asset, amount, principal_amount, fee_amount, occurred_at_ms, recorded_at_ms)
         VALUES ('y', 'w', 'p', 'expense_settled', 'usdc', 5, 5, 0, ?, ?)`,
      ).run(NOW, NOW),
    ).toThrow(/UNIQUE/);
  });
});
