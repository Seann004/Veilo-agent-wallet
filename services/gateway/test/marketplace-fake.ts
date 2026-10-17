// Test-only fake marketplace implementing the seller-host side of the protocol in memory.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request, type Response } from "express";
import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { DEVNET_CAIP2, DEVNET_GENESIS_HASH } from "@veilo/contracts";
import {
  completeRequestSchema,
  computeInputDigest,
  computeQuoteDigest,
  failRequestSchema,
  leaseRequestSchema,
  paymentEvidenceRequestSchema,
  type MarketplaceQuote,
  type QuoteFields,
  type SellerHostJobView,
} from "@veilo/contracts/marketplace";
import { deriveAta } from "@veilo/x402-client";
import { MINT } from "./harness";

export const SELLER_ORIGIN = "http://127.0.0.1:4106";
export const SELLER_IDENTITY = "veilo-seller-host-devnet";
export const RUNTIME_VERSION = "managed:research-summary:v1";

interface FakeJob {
  view: SellerHostJobView;
  evidence: Array<{ operationId: string; signature: string }>;
  claims: number;
  grants: number;
  lease: { attemptId: string; leaseToken: string; leaseGeneration: number } | undefined;
  heartbeats: number;
  completes: Array<{ envelope: unknown; texts: string[] }>;
  fails: Array<{ code: string; uncertain: boolean }>;
}

export class FakeMarketplace {
  readonly token = `mkt_${randomBytes(24).toString("base64url")}`;
  jobs = new Map<string, FakeJob>();
  url = "";
  down = false;
  /** Claims refused with 409 before the job counts as queued. */
  notQueuedClaims = 0;
  /** Revokes the active lease (and requeues the job) just before the next completion is accepted. */
  revokeLeaseBeforeComplete = 0;
  unauthorized = 0;
  recipient!: KeyPairSigner;
  #server: Server | undefined;

  async start(): Promise<this> {
    this.recipient = await generateKeyPairSigner();
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use((req, res, next) => {
      if (req.header("authorization") !== `Bearer ${this.token}`) {
        this.unauthorized += 1;
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      if (this.down) {
        res.status(503).json({ error: "down" });
        return;
      }
      next();
    });
    const job = (req: Request, res: Response): FakeJob | undefined => {
      const j = this.jobs.get(String(req.params.jobId));
      if (!j) res.status(404).json({ error: "not found" });
      return j;
    };
    const leaseMatches = (j: FakeJob, b: { attemptId: string; leaseToken: string }) =>
      j.lease !== undefined && j.lease.attemptId === b.attemptId && j.lease.leaseToken === b.leaseToken;

    app.get("/internal/seller-host/jobs/:jobId", (req, res) => {
      const j = job(req, res);
      if (j) res.json(j.view);
    });
    app.post("/internal/seller-host/jobs/:jobId/payment-evidence", (req, res) => {
      const j = job(req, res);
      if (!j) return;
      const b = paymentEvidenceRequestSchema.parse(req.body);
      if (j.evidence.some((e) => e.signature === b.signature)) {
        res.status(409).json({ error: "already recorded" });
        return;
      }
      j.evidence.push(b);
      if (j.view.state === "awaiting_payment") j.view.state = "queued";
      res.status(201).json({ recorded: true });
    });
    app.post("/internal/seller-host/jobs/:jobId/claim", (req, res) => {
      const j = job(req, res);
      if (!j) return;
      j.claims += 1;
      if (this.notQueuedClaims > 0 || j.view.state !== "queued") {
        if (this.notQueuedClaims > 0) this.notQueuedClaims -= 1;
        res.status(409).json({ error: "not queued" });
        return;
      }
      j.grants += 1;
      j.lease = { attemptId: randomUUID(), leaseToken: randomBytes(32).toString("base64url"), leaseGeneration: j.grants };
      j.view.state = "running";
      res.json({ ...j.lease, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
    });
    app.post("/internal/seller-host/jobs/:jobId/heartbeat", (req, res) => {
      const j = job(req, res);
      if (!j) return;
      const b = leaseRequestSchema.parse(req.body);
      j.heartbeats += 1;
      if (!leaseMatches(j, b) || j.view.state !== "running") {
        res.status(409).json({ error: "stale lease" });
        return;
      }
      res.json({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() });
    });
    app.post("/internal/seller-host/jobs/:jobId/complete", (req, res) => {
      const j = job(req, res);
      if (!j) return;
      const b = completeRequestSchema.parse(req.body);
      if (this.revokeLeaseBeforeComplete > 0) {
        this.revokeLeaseBeforeComplete -= 1;
        j.lease = undefined;
        j.view.state = "queued";
      }
      if (!leaseMatches(j, b) || j.view.state !== "running" || b.envelope.attemptId !== j.lease?.attemptId) {
        res.status(409).json({ error: "stale lease" });
        return;
      }
      for (const a of b.envelope.artifacts) {
        const body = b.artifactBodies.find((x) => x.artifactId === a.artifactId);
        const sha = createHash("sha256").update(body?.text ?? "", "utf8").digest("hex");
        if (!body || sha !== a.sha256 || Buffer.byteLength(body.text, "utf8") !== a.bytes) {
          res.status(422).json({ error: "artifact mismatch" });
          return;
        }
      }
      j.completes.push({ envelope: b.envelope, texts: b.artifactBodies.map((x) => x.text) });
      j.view.state = "succeeded";
      j.lease = undefined;
      res.json({ state: "succeeded" });
    });
    app.post("/internal/seller-host/jobs/:jobId/fail", (req, res) => {
      const j = job(req, res);
      if (!j) return;
      const b = failRequestSchema.parse(req.body);
      if (!leaseMatches(j, b)) {
        res.status(409).json({ error: "stale lease" });
        return;
      }
      j.fails.push({ code: b.code, uncertain: b.uncertain });
      j.view.state = b.uncertain ? "delivery_uncertain" : "failed";
      j.lease = undefined;
      res.json({ state: j.view.state });
    });

    this.#server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => this.#server?.once("listening", () => r()));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
    return this;
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => (this.#server ? this.#server.close(() => r()) : r()));
  }

  /**
   * Adds a job awaiting payment. `fields` overrides quote fields before the digest is
   * computed; `tamper` changes fields after it, so the digest no longer matches.
   */
  async addJob(
    o: {
      brief?: string;
      fields?: Partial<QuoteFields>;
      tamper?: Partial<MarketplaceQuote>;
      state?: string;
      runtime?: Partial<SellerHostJobView["runtime"]>;
      expiresAt?: Date;
    } = {},
  ): Promise<{ jobId: string; input: { jobId: string; listingVersionId: string; quoteDigest: string; brief: string }; quote: MarketplaceQuote }> {
    const jobId = randomUUID();
    const listingVersionId = randomUUID();
    const brief = o.brief ?? "Summarize how repair cafes reduce household waste.";
    const fields: QuoteFields = {
      id: randomUUID(),
      operationId: `op_hire_${randomUUID()}`,
      buyerWorkspaceId: randomUUID(),
      jobId,
      listingVersionId,
      runtimeVersion: RUNTIME_VERSION,
      inputDigest: computeInputDigest(brief),
      network: DEVNET_CAIP2,
      genesisHash: DEVNET_GENESIS_HASH,
      mint: MINT,
      decimals: 6,
      recipient: this.recipient.address,
      recipientAta: await deriveAta(this.recipient.address, MINT),
      sellerOrigin: SELLER_ORIGIN,
      sellerIdentity: SELLER_IDENTITY,
      baseUnits: "250000",
      feeBps: 0,
      feeUnits: "0",
      totalUnits: "250000",
      maxNetworkFeeLamports: "10000000",
      termsVersion: "2026-10-17",
      expiresAt: (o.expiresAt ?? new Date(Date.parse("2026-10-15T00:05:00Z"))).toISOString(),
      ...o.fields,
    };
    const quote: MarketplaceQuote = { ...fields, quoteDigest: computeQuoteDigest(fields), ...o.tamper };
    const view: SellerHostJobView = {
      jobId,
      state: o.state ?? "awaiting_payment",
      listingVersionId,
      quote,
      runtime: {
        kind: "managed_template",
        template: "research-summary",
        runtimeVersionId: RUNTIME_VERSION,
        modelId: null,
        maxOutputTokens: 1_500,
        sellerInstructions: "Cite only what the brief supports.",
        outputFormat: "markdown",
        sections: ["Summary", "Key points"],
        ...o.runtime,
      },
      inputs: [],
    };
    this.jobs.set(jobId, { view, evidence: [], claims: 0, grants: 0, lease: undefined, heartbeats: 0, completes: [], fails: [] });
    return { jobId, input: { jobId, listingVersionId, quoteDigest: quote.quoteDigest, brief }, quote };
  }

  job(jobId: string): FakeJob {
    return this.jobs.get(jobId) as FakeJob;
  }
}
