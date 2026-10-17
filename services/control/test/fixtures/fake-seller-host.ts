// TEST ONLY. A minimal seller host speaking the gateway purchase protocol for the
// `specialist-job` SKU. Payments are synthetic: it records the payment header it receives and
// reports a synthetic finalized settlement. No chain transaction or facilitator is involved.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { getBase58Decoder } from "@solana/kit";

export interface SellerConfig {
  identity: string;
  network: string;
  mint: string;
  payTo: string;
  merchantAta: string;
  price: bigint;
}

interface QuoteEntry {
  quoteId: string;
  operationId: string;
  requestDigest: string;
  input: unknown;
  paid: { header: string; signature: string } | null;
}

export class FakeSellerHost {
  server!: Server;
  origin = "";
  readonly accounts = new Map<string, string>();
  readonly quotes = new Map<string, QuoteEntry>();
  payments = 0;
  accountRequests = 0;
  /** Overrides applied to the next quote replies (to simulate a tampering seller). */
  quoteOverride: ((q: Record<string, unknown>) => void) | undefined;
  /** Drop the reply of the next N paid execute calls after the payment is recorded. */
  dropPaidReplies = 0;

  constructor(readonly cfg: SellerConfig, readonly now: () => number) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.#handle(req, res));
    this.server.listen(0, "127.0.0.1");
    await new Promise<void>((r) => this.server.once("listening", () => r()));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }

  #state(q: QuoteEntry): Record<string, unknown> {
    if (!q.paid) return { state: "unpaid", payment: null };
    return {
      state: "delivered",
      payment: { txSignature: q.paid.signature, amount: this.cfg.price.toString(), finalizedSlot: "4242", observedAt: new Date(this.now()).toISOString() },
      result: { summary: "TEST specialist deliverable", input: q.input },
    };
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
    const send = (status: number, b: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
    };
    const path = req.url ?? "/";
    if (req.method === "POST" && path === "/v1/accounts") {
      this.accountRequests += 1;
      const ws = String(body.workspaceId ?? "");
      if (this.accounts.has(ws)) return send(409, { error: { code: "IDEMPOTENCY_CONFLICT", message: "account exists" } });
      const token = `vsa_${randomBytes(24).toString("base64url")}`;
      this.accounts.set(ws, token);
      return send(201, { accountId: `acct_${randomUUID()}`, token });
    }
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!auth || ![...this.accounts.values()].includes(auth)) return send(401, { error: { code: "UNAUTHENTICATED", message: "account credential required" } });
    if (req.method === "POST" && path === "/quotes") {
      const quoteId = `q_${randomUUID()}`;
      const entry: QuoteEntry = { quoteId, operationId: String(body.operationId), requestDigest: String(body.requestDigest), input: body.input, paid: null };
      this.quotes.set(quoteId, entry);
      const view: Record<string, unknown> = {
        quoteId,
        operationId: entry.operationId,
        accountId: "acct",
        sku: body.sku,
        requestDigest: entry.requestDigest,
        paymentPath: "x402",
        charge: { amount: this.cfg.price.toString(), unit: "usdc_base_units" },
        usageLimits: { maxInputTokens: null, maxOutputTokens: null },
        recipient: { network: this.cfg.network, asset: this.cfg.mint, payTo: this.cfg.payTo, merchantAta: this.cfg.merchantAta, feePayer: this.cfg.payTo, facilitatorUrl: "https://facilitator.test.invalid" },
        gateway: { identity: this.cfg.identity, origin: this.origin },
        executeUrl: `${this.origin}/v1/purchases/${quoteId}/execute`,
        delivery: "test",
        createdAt: new Date(this.now()).toISOString(),
        expiresAt: new Date(this.now() + 300_000).toISOString(),
        purchaseState: null,
      };
      this.quoteOverride?.(view);
      return send(201, view);
    }
    let m: RegExpExecArray | null;
    if (req.method === "POST" && (m = /^\/v1\/purchases\/([^/]+)\/execute$/.exec(path))) {
      const q = this.quotes.get(decodeURIComponent(m[1] as string));
      if (!q) return send(404, { error: { code: "NOT_FOUND", message: "quote" } });
      const header = req.headers["payment-signature"];
      if (typeof header !== "string") {
        if (q.paid) return send(200, this.#state(q));
        return send(402, {
          x402Version: 2,
          accepts: [{ scheme: "exact", network: this.cfg.network, amount: this.cfg.price.toString(), asset: this.cfg.mint, payTo: this.cfg.payTo, maxTimeoutSeconds: 60, extra: {} }],
          quoteId: q.quoteId,
        });
      }
      if (q.paid && q.paid.header !== header) return send(409, { error: { code: "IDEMPOTENCY_CONFLICT", message: "a different payment already settled this quote" } });
      if (!q.paid) {
        q.paid = { header, signature: getBase58Decoder().decode(randomBytes(64)) };
        this.payments += 1;
      }
      if (this.dropPaidReplies > 0) {
        this.dropPaidReplies -= 1;
        res.socket?.destroy();
        return;
      }
      return send(200, this.#state(q));
    }
    if (req.method === "GET" && (m = /^\/v1\/purchases\/([^/]+)\/result$/.exec(path))) {
      const q = this.quotes.get(decodeURIComponent(m[1] as string));
      if (!q) return send(404, { error: { code: "NOT_FOUND", message: "quote" } });
      return send(200, this.#state(q));
    }
    return send(404, { error: { code: "NOT_FOUND", message: "no such endpoint" } });
  }
}
