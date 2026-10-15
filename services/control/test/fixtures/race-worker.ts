// Separate OS process that opens its own connection to the ledger file and attempts one
// authorization when the parent broadcasts "go", so concurrent attempts genuinely contend.
import { openControlDatabase } from "@veilo/db";
import { createLedger } from "../../src/context";
import { ControlError } from "../../src/errors";
import { authorizePurchase } from "../../src/ledger/authorize";

const [dbPath, workspaceId, agentId, serviceId, sku, key, requestDigest] = process.argv.slice(2) as [
  string, string, string, string, string, string, string,
];
const db = openControlDatabase(dbPath);
const ledger = createLedger(db);
const send = (msg: unknown) => process.send?.(msg);

process.on("message", () => {
  let result: unknown;
  try {
    const r = authorizePurchase(ledger, {
      workspaceId,
      agentId,
      idempotencyKey: key,
      serviceId,
      sku,
      paymentPath: "private_x402",
      requestDigest,
    });
    result = { ok: true, purchaseId: r.purchase.id, created: r.created };
  } catch (error) {
    result = { ok: false, code: error instanceof ControlError ? error.code : String((error as Error).message) };
  }
  db.close();
  process.send?.(result, () => process.exit(0));
});

send({ ready: true });
