import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, openSqlite, runMigrations, SECRETS_DB_ROLE, type SqliteDatabase } from "../src/index";

let dir: string;
let db: SqliteDatabase | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const NOW = 1_760_000_000_000;
const hex = (c: string) => c.repeat(64);

function note(d: SqliteDatabase, id: string, commitment: string, keyIndex: number, parent: string | null = null) {
  d.prepare(`INSERT INTO wallet_note (id, commitment, origin, parent_note_id, key_index, ciphertext, nonce, key_version, created_at_ms) VALUES (?, ?, ?, ?, ?, x'00', zeroblob(12), 1, ?)`).run(
    id,
    commitment,
    parent === null ? "deposit" : "change",
    parent,
    keyIndex,
    NOW,
  );
}

function funding(d: SqliteDatabase, purchase: string, input: string, change: string, fresh: string, nullifier: string, step = "prepared") {
  d.prepare(
    `INSERT INTO funding (purchase_id, operation_id, input_note_id, change_note_id, fresh_wallet, payout, token_fee, sponsor_lamport_cap, nullifier_hash, valid_until_slot,
       intent_json, proof_json, binding_json, step, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, 10000, 0, 3000000, ?, 100, '{}', '{}', '{}', ?, ?, ?)`,
  ).run(purchase, `op-${purchase}`, input, change, fresh, nullifier, step, NOW, NOW);
}

describe("secrets migration 0003: funding attempts", () => {
  it("rebuilds funding in place: rows, foreign keys and triggers survive; nullifiers are unique among live attempts only", () => {
    dir = mkdtempSync(join(tmpdir(), "veilo-db-attempts-"));
    db = openSqlite(join(dir, "wallet-secrets.sqlite"));
    db.defaultSafeIntegers(true);
    const all = loadMigrations("secrets");
    runMigrations(db, all.filter((m) => m.version <= 2), SECRETS_DB_ROLE);

    // A pre-0003 database with a finalized funding, its merchant payment and an expired attempt.
    note(db, "n1", hex("1"), 1);
    note(db, "c1", hex("2"), 2, "n1");
    note(db, "n2", hex("3"), 3);
    note(db, "c2", hex("4"), 4, "n2");
    funding(db, "p1", "n1", "c1", "fresh1", hex("a"), "prepared");
    db.prepare(`UPDATE funding SET step = 'released' WHERE purchase_id = 'p1'`).run();
    db.prepare(`UPDATE funding SET step = 'finalized' WHERE purchase_id = 'p1'`).run();
    db.prepare(
      `INSERT INTO merchant_payment (purchase_id, fresh_wallet, message_hash, payment_header, amount, state, signed_at_ms, updated_at_ms) VALUES ('p1', 'fresh1', 'mh', 'hdr', 10000, 'signed', ?, ?)`,
    ).run(NOW, NOW);
    funding(db, "p2", "n2", "c2", "fresh2", hex("b"));
    db.prepare(`UPDATE funding SET step = 'released' WHERE purchase_id = 'p2'`).run();
    db.prepare(`UPDATE funding SET step = 'expired_unsettled' WHERE purchase_id = 'p2'`).run();
    // Before 0003 a second attempt with the same nullifier is impossible.
    note(db, "c3", hex("5"), 5, "n2");
    expect(() => funding(db!, "p3", "n2", "c3", "fresh3", hex("b"))).toThrow(/UNIQUE/);

    expect(runMigrations(db, all.filter((m) => m.version <= 3), SECRETS_DB_ROLE)).toEqual([3]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1n);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.prepare(`SELECT purchase_id, step FROM funding ORDER BY purchase_id`).all()).toEqual([
      { purchase_id: "p1", step: "finalized" },
      { purchase_id: "p2", step: "expired_unsettled" },
    ]);

    // New attempt for the expired note: same nullifier, new change note and fresh wallet.
    funding(db, "p3", "n2", "c3", "fresh3", hex("b"));
    // A second live attempt for the same nullifier (or note) is still refused.
    note(db, "c4", hex("6"), 6, "n2");
    expect(() => funding(db!, "p4", "n2", "c4", "fresh4", hex("b"))).toThrow(/UNIQUE/);
    // Fresh wallets and change notes are never reused across attempts.
    expect(() => funding(db!, "p5", "n1", "c4", "fresh3", hex("c"))).toThrow(/UNIQUE/);

    // Foreign keys still point at the rebuilt table, and the triggers are back.
    expect(() =>
      db!.prepare(`INSERT INTO merchant_payment (purchase_id, fresh_wallet, message_hash, payment_header, amount, state, signed_at_ms, updated_at_ms) VALUES ('nope', 'x', 'y', 'z', 1, 'signed', ?, ?)`).run(NOW, NOW),
    ).toThrow(/FOREIGN KEY/);
    expect(() => db!.prepare(`UPDATE funding SET nullifier_hash = ? WHERE purchase_id = 'p3'`).run(hex("d"))).toThrow(/immutable/);
    expect(() => db!.prepare(`UPDATE funding SET step = 'prepared' WHERE purchase_id = 'p2'`).run()).toThrow(/invalid funding step/);
    expect(() => db!.prepare(`DELETE FROM funding WHERE purchase_id = 'p2'`).run()).toThrow(/retained/);
  });
});
