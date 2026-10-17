import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { advanceAuthority, recordFundingFinalized } from "@veilo/control/src/ledger/purchases";
import { BackupError, createBackup, readBackup, restoreBackup } from "../src/backup";
import { reconcileOnStartup, RESTORE_FLAG } from "../src/reconcile";
import { ensureOwnerServiceSecret, WalletKeys } from "../src/secret";
import { authorize, BINDING, createWorld, depositAndApprove, fundingInput, type TestWallet, type World } from "./harness";

let world: World;
let w: TestWallet;
beforeEach(async () => {
  world = await createWorld();
  w = world.open();
});
afterEach(() => world.cleanup());

const ledger = () => world.control.env.ledger;
const restart = () => {
  w.close();
  w = world.open();
  return w;
};
const services = () => ({ funding: w.funding, notes: w.notes, owner: w.owner });

describe("note encryption", () => {
  it("round-trips note secrets through AES-GCM and rejects tampering or a different key", async () => {
    await depositAndApprove(world, w, 300_000n);
    const n = w.store.notes()[0]!;
    expect(n.value).toBe(300_000n);
    restart();
    const again = w.store.note(n.id)!;
    expect(again).toMatchObject({ nullifierSecret: n.nullifierSecret, noteSecret: n.noteSecret, label: n.label, value: n.value });
    const row = w.store.db.prepare(`SELECT ciphertext, nonce FROM wallet_note WHERE id = ?`).get(n.id) as { ciphertext: Buffer; nonce: Buffer };
    const flipped = Buffer.from(row.ciphertext);
    flipped[0]! ^= 1;
    expect(() => w.keys.open(flipped, row.nonce, `wallet_note:${n.id}:${n.commitment}`)).toThrow(/authentication/);
    expect(() => w.keys.open(row.ciphertext, row.nonce, `wallet_note:other:${n.commitment}`)).toThrow(/authentication/);
    const other = new WalletKeys(new Uint8Array(32).fill(9));
    expect(() => other.open(row.ciphertext, row.nonce, `wallet_note:${n.id}:${n.commitment}`)).toThrow();
  });

  it("creates the owner service secret once with restrictive permissions and never serializes keys", () => {
    const path = join(world.dir, "s2", "secret");
    expect(ensureOwnerServiceSecret(path).created).toBe(true);
    const before = readFileSync(path, "utf8");
    expect(ensureOwnerServiceSecret(path).created).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o077).toBe(0);
    const keys = WalletKeys.fromFile(path);
    const secretPart = before.trim().split(":")[1]!;
    expect(JSON.stringify({ keys })).not.toContain(secretPart);
    expect(inspect(keys)).toBe("[WalletKeys redacted]");
  });
});

describe("fresh payment wallets", () => {
  it("are unique per purchase, persisted with their counter, and stable across restart", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) seen.add(w.store.reserveFreshWallet(`00000000-0000-0000-0000-${String(i).padStart(12, "0")}`, `op${i}`).address);
    expect(seen.size).toBe(20);
    const again = w.store.reserveFreshWallet("00000000-0000-0000-0000-000000000003", "op3");
    expect(again.created).toBe(false);
    restart();
    expect(w.store.counter("onetime")).toBe(20);
    const next = w.store.reserveFreshWallet("00000000-0000-0000-0000-000000000099", "op99");
    expect(next.counter).toBe(20);
    expect(seen.has(next.address)).toBe(false);
    expect(() => w.store.db.prepare(`DELETE FROM fresh_wallet_key`).run()).toThrow(/retained/);
    expect(() => w.store.db.prepare(`UPDATE key_counter SET next_value = 0 WHERE name = 'onetime'`).run()).toThrow(/only increase/);
  });
});

describe("REC-01 restart at each multi-leg boundary", () => {
  it("crash after the fresh key is reserved but before the proof is stored reuses that key", async () => {
    await depositAndApprove(world, w, 1_000_000n);
    const p = authorize(world, "c1");
    advanceAuthority(ledger(), p.id, "prepare_proof");
    w.deps.prover = { prove: async () => Promise.reject(new Error("crash during proving")) };
    await expect(w.funding.prepare(fundingInput(world, p.id))).rejects.toThrow(/crash/);
    const reserved = w.store.freshWallets().find((f) => f.purchaseId === p.id)!;
    restart();
    const r = await w.funding.prepare(fundingInput(world, p.id));
    expect(r).toMatchObject({ status: "prepared", payer: reserved.address });
    expect(w.store.freshWallets()).toHaveLength(1);
  });

  it("crash after release is recorded but before the relayer call: startup reconciliation sends the same proof once", async () => {
    await depositAndApprove(world, w, 1_000_000n);
    const p = authorize(world, "c2");
    advanceAuthority(ledger(), p.id, "prepare_proof");
    await w.funding.prepare(fundingInput(world, p.id));
    advanceAuthority(ledger(), p.id, "release_proof");
    world.relayer.mode = "down";
    expect((await w.funding.release(p.id, p.id)).status).toBe("uncertain");
    restart();
    world.relayer.mode = "land";
    const report = await reconcileOnStartup(w.deps, services());
    expect(report.fundings[p.id]).toBe("submitted");
    expect((await w.funding.status(p.id)).status).toBe("finalized");
    expect(world.relayer.received).toHaveLength(1);
  });

  it("crash after the withdrawal landed: startup reconciliation finalizes from chain evidence", async () => {
    await depositAndApprove(world, w, 1_000_000n);
    const p = authorize(world, "c3");
    advanceAuthority(ledger(), p.id, "prepare_proof");
    await w.funding.prepare(fundingInput(world, p.id));
    advanceAuthority(ledger(), p.id, "release_proof");
    world.relayer.mode = "lose_response";
    await w.funding.release(p.id, p.id);
    restart();
    world.relayer.mode = "land";
    const report = await reconcileOnStartup(w.deps, services());
    expect(report.fundings[p.id]).toBe("finalized");
    expect(report.ready).toBe(true);
  });

  it("crash after the merchant payment is signed: no second signature after restart", async () => {
    await depositAndApprove(world, w, 1_000_000n);
    const p = authorize(world, "c4");
    advanceAuthority(ledger(), p.id, "prepare_proof");
    await w.funding.prepare(fundingInput(world, p.id));
    advanceAuthority(ledger(), p.id, "release_proof");
    await w.funding.release(p.id, p.id);
    const fin = await w.funding.status(p.id);
    if (fin.status !== "finalized") throw new Error("expected finalized");
    recordFundingFinalized(ledger(), p.id, { ...fin.evidence });
    advanceAuthority(ledger(), p.id, "sign_merchant");
    const body = { fundingRef: p.id, paymentRequired: {}, binding: BINDING, exactAmountUsdc: 100_000n };
    const first = await w.funding.signMerchant(p.id, body);
    restart();
    world.chain.validBlockhashes.add(world.merchant.blockhash);
    const report = await reconcileOnStartup(w.deps, services());
    expect(report.merchant[p.id]).toBe("signed");
    expect(await w.funding.signMerchant(p.id, body)).toEqual(first);
    expect(world.merchant.calls).toBe(1);
  });

  it("flags control funding the wallet cannot account for and blocks new proofs", async () => {
    await depositAndApprove(world, w, 1_000_000n);
    await depositAndApprove(world, w, 2_000_000n);
    const p = authorize(world, "c5");
    advanceAuthority(ledger(), p.id, "prepare_proof");
    advanceAuthority(ledger(), p.id, "release_proof");
    const report = await reconcileOnStartup(w.deps, services());
    expect(report.ready).toBe(false);
    expect(report.mismatches.join(" ")).toMatch(/without matching wallet state/);
    const q = authorize(world, "c6");
    advanceAuthority(ledger(), q.id, "prepare_proof");
    expect((await w.funding.prepare(fundingInput(world, q.id))).status).toBe("recovery_required");
  });
});

describe("BAK-01 encrypted backup and restore with a pending spend", () => {
  it("restores without reusing one-time addresses, recovers change created after the backup and blocks new funding until reconciled", async () => {
    await depositAndApprove(world, w, 1_000_000n);
    await depositAndApprove(world, w, 2_000_000n);
    const secretsDb = join(world.dir, "wallet-secrets.sqlite");
    const controlDb = world.control.env.dbPath;
    const backupPath = join(world.dir, "b", "x.veilo-backup");
    const { manifest } = await createBackup({ secretsDbPath: secretsDb, controlDbPath: controlDb, outPath: backupPath, keys: w.keys });
    expect(manifest.files.map((f) => f.name)).toEqual(["wallet-secrets.sqlite", "control.sqlite"]);
    const raw = readFileSync(backupPath);
    for (const n of w.store.notes()) expect(raw.includes(Buffer.from(n.noteSecret.toString()))).toBe(false);

    // After the backup: a purchase is funded on-chain (fresh key + change note allocated).
    const p = authorize(world, "after-backup");
    advanceAuthority(ledger(), p.id, "prepare_proof");
    await w.funding.prepare(fundingInput(world, p.id));
    advanceAuthority(ledger(), p.id, "release_proof");
    await w.funding.release(p.id, p.id);
    const fresh = w.store.funding(p.id)!.fresh_wallet;
    const changeCommitment = w.store.note(w.store.funding(p.id)!.change_note_id)!.commitment;
    const usedAddresses = new Set(w.store.freshWallets().map((f) => f.address));
    w.close();

    const summary = restoreBackup({ file: backupPath, secretsDbPath: secretsDb, controlDbPath: controlDb, keys: w.keys });
    expect(summary.notes).toBe(2);
    expect(summary.movedAside.length).toBe(1);
    expect(existsSync(summary.movedAside[0]!)).toBe(true);
    w = world.open();
    expect(w.store.funding(p.id)).toBeUndefined();
    expect(w.store.flags().map((f) => f.name)).toContain(RESTORE_FLAG);
    // Counters jumped: the next one-time key is not any address used before the restore.
    const next = w.store.reserveFreshWallet("11111111-1111-1111-1111-111111111111", "new-op");
    expect(usedAddresses.has(next.address)).toBe(false);
    expect(next.counter).toBeGreaterThanOrEqual(1000);

    // New funding is refused until reconciliation has run.
    const q = authorize(world, "post-restore");
    advanceAuthority(ledger(), q.id, "prepare_proof");
    expect((await w.funding.prepare(fundingInput(world, q.id))).status).toBe("recovery_required");

    const report = await reconcileOnStartup(w.deps, services());
    expect(report.recovered.changeNotes).toBe(1);
    expect(report.recovered.freshWallets).toBe(1);
    expect(w.store.noteByCommitment(changeCommitment)?.state).toBe("pending_change");
    expect(w.store.freshWallets().some((f) => f.address === fresh)).toBe(true);
    // The recovered purchase stays flagged for owner attention; no new authority is granted.
    expect(report.ready).toBe(false);
    expect(w.store.flags().some((f) => f.name === `recovery_required:${p.id}`)).toBe(true);
  });

  it("rejects a backup under another owner secret or with modified bytes", async () => {
    await depositAndApprove(world, w, 300_000n);
    const out = join(world.dir, "b2", "y.veilo-backup");
    await createBackup({ secretsDbPath: join(world.dir, "wallet-secrets.sqlite"), controlDbPath: world.control.env.dbPath, outPath: out, keys: w.keys });
    expect(() => readBackup(out, new WalletKeys(new Uint8Array(32).fill(3)))).toThrow(BackupError);
    const bytes = readFileSync(out);
    bytes[bytes.length - 20]! ^= 0xff;
    writeFileSync(out, bytes);
    expect(() => readBackup(out, w.keys)).toThrow(/authentication/);
  });
});
