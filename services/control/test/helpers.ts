import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddressDecoder, getBase58Decoder } from "@solana/kit";
import {
  DEFAULT_AGENTS,
  DEMO_TOKEN_DECIMALS,
  DEMO_TOKEN_MINT,
  DEVNET_CAIP2,
  type AgentPolicyInput,
  type WorkspacePolicyInput,
} from "@veilo/contracts";
import { openControlDatabase, type SqliteDatabase } from "@veilo/db";
import { createLedger, type Ledger } from "../src/context";
import { registerApprovedNote } from "../src/ledger/notes";
import {
  activatePolicyVersion,
  insertAgentPolicyDraft,
  insertWorkspacePolicyDraft,
  listAgents,
  seedWorkspace,
  type AgentRow,
  type WorkspaceRow,
} from "../src/ledger/workspace";
import { immediate } from "@veilo/db";

export interface TestKeypair {
  address: string;
  privateKey: KeyObject;
  /** Raw 32-byte private scalar, kept only to assert it never appears in output. */
  secretBytes: Buffer;
  signText(message: string): string;
}

/** Throwaway in-memory Ed25519 keypair. Never written to disk. */
export function testKeypair(): TestKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const secretBytes = Buffer.from(privateKey.export({ format: "jwk" }).d as string, "base64url");
  const address = getAddressDecoder().decode(pub);
  return {
    address,
    privateKey,
    secretBytes,
    signText: (message: string) => getBase58Decoder().decode(sign(null, Buffer.from(message, "utf8"), privateKey)),
  };
}

export interface TestEnv {
  dir: string;
  dbPath: string;
  db: SqliteDatabase;
  ledger: Ledger;
  clock: { t: number };
  owner: TestKeypair;
  ws: WorkspaceRow;
  agents: Record<"Shawn" | "Prince" | "Mira", AgentRow>;
  cleanup(): void;
}

export const T0 = Date.parse("2026-10-14T00:00:00.000Z");

export function createEnv(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "veilo-control-"));
  const dbPath = join(dir, "control.sqlite");
  const db = openControlDatabase(dbPath);
  const clock = { t: T0 };
  const ledger = createLedger(db, () => clock.t);
  const owner = testKeypair();
  const { workspace } = seedWorkspace(ledger, {
    ownerPubkey: owner.address,
    network: DEVNET_CAIP2,
    mint: DEMO_TOKEN_MINT,
    mintDecimals: DEMO_TOKEN_DECIMALS,
  });
  const byName = Object.fromEntries(listAgents(ledger, workspace.id).map((a) => [a.name, a])) as TestEnv["agents"];
  return {
    dir,
    dbPath,
    db,
    ledger,
    clock,
    owner,
    ws: workspace,
    agents: byName,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const owner = { type: "owner" as const, id: "owner" };

/** Owner activation of the seeded drafts, optionally replacing them with new drafts first. */
export function activateDefaults(
  env: TestEnv,
  overrides: { workspace?: Partial<WorkspacePolicyInput>; agents?: Partial<Record<"Shawn" | "Prince" | "Mira", Partial<AgentPolicyInput>>> } = {},
): void {
  const { ledger, ws } = env;
  if (overrides.workspace) {
    const draft = immediate(ledger.db, () =>
      insertWorkspacePolicyDraft(ledger, ws.id, { tier: "bounded_automatic", lifetimeTestUsdc: "10000000", rolling24hTestUsdc: "5000000", sponsorLamportLimit: "100000000", ...overrides.workspace }, "owner"),
    );
    activatePolicyVersion(ledger, ws.id, null, Number(draft.version), owner);
  } else {
    activatePolicyVersion(ledger, ws.id, null, 1, owner);
  }
  for (const def of DEFAULT_AGENTS) {
    const name = def.name as "Shawn" | "Prince" | "Mira";
    const agent = env.agents[name];
    const o = overrides.agents?.[name];
    if (o) {
      const draft = immediate(ledger.db, () => insertAgentPolicyDraft(ledger, ws.id, agent.id, { ...def.policy, ...o }, "owner"));
      activatePolicyVersion(ledger, ws.id, agent.id, Number(draft.version), owner);
    } else {
      activatePolicyVersion(ledger, ws.id, agent.id, 1, owner);
    }
  }
}

export interface TestSku {
  sku: string;
  paymentPath: "private_x402" | "prepaid_credits";
  price?: bigint;
  fee?: bigint;
  units?: bigint;
  lamports?: bigint;
}

/** Adds an approved, bound test service with the given SKUs. */
export function addService(env: TestEnv, skus: TestSku[], key = `svc-${randomBytes(4).toString("hex")}`): string {
  const { ledger, ws } = env;
  const id = ledger.newId();
  const now = ledger.now();
  ledger.db
    .prepare(
      `INSERT INTO approved_service (id, workspace_id, service_key, origin, gateway_identity, recipient, recipient_ata, network, mint,
         status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, 'http://127.0.0.1:4104', 'gw', 'Recipient1111', 'Ata1111', ?, ?, 'approved', ?, ?)`,
    )
    .run(id, ws.id, key, ws.network, ws.mint, now, now);
  for (const s of skus) {
    ledger.db
      .prepare(
        `INSERT INTO service_sku (id, service_id, sku, payment_path, price_usdc, max_fee_usdc, usage_units, sponsor_lamports)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ledger.newId(), id, s.sku, s.paymentPath, s.price ?? 0n, s.fee ?? 0n, s.units ?? 0n, s.lamports ?? 0n);
  }
  return id;
}

export function addNotes(env: TestEnv, values: bigint[]): void {
  immediate(env.ledger.db, () => {
    for (const v of values) registerApprovedNote(env.ledger, env.ws.id, randomBytes(32).toString("hex"), v);
  });
}

export const digest = (seed: string): string =>
  Buffer.from(seed.padEnd(32, ".").slice(0, 32)).toString("hex");
