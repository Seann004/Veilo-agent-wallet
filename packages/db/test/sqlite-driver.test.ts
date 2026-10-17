import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openSqlite } from "../src/index";

describe("sqlite driver", () => {
  it("opens a file database in WAL mode with foreign keys on", () => {
    const dir = mkdtempSync(join(tmpdir(), "veilo-db-"));
    const db = openSqlite(join(dir, "test.sqlite"));
    try {
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
