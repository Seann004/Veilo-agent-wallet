// TEST ONLY. A stand-in for the hosted marketplace's controller API. It verifies controller
// request signatures and nonces the way the real service must, serves canned payment requests
// and a catalogue, and can drop replies to exercise outbox re-delivery. It is not the marketplace.
import { createHash, createPublicKey, verify } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { getAddressEncoder, getBase58Encoder, address } from "@solana/kit";
import { CONTROLLER_HEADERS, CONTROLLER_REQUEST_MAX_SKEW_MS, controllerSigningMessage, controllerStatusSchema, payerBindingMessage, type PaymentRequest } from "@veilo/contracts/marketplace";

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

export class FakeMarketplace {
  server!: Server;
  base = "";
  controllerKey: string | undefined;
  keyId: string | undefined;
  readonly nonces = new Set<string>();
  replays = 0;
  badSignatures = 0;
  requests: PaymentRequest[] = [];
  catalog: unknown[] = [];
  readonly calls: RecordedCall[] = [];
  /** Topic path fragments whose next N replies are dropped after the request is recorded. */
  readonly dropReplies = new Map<string, number>();
  readonly evidence = new Map<string, { signature: string; deliveries: number }>();
  readonly decisions = new Map<string, unknown[]>();
  readonly statuses = new Map<string, unknown[]>();
  readonly hires: unknown[] = [];
  readonly payers = new Map<string, string>();
  readonly accepted = new Map<string, boolean>();
  refusePayer = false;
  badPayerProofs = 0;
  /** Quote digests for operations not listed in `requests` (requests received directly by the bridge). */
  readonly knownDigests = new Map<string, string>();
  pendingEvidence = 0;
  /** When false, a reported payer is acknowledged but not bound (evidence then stays pending). */
  applyPayer = true;
  /** Canned replies served (without recording the call's effect) before the next real ones, per topic fragment. */
  readonly forcedReplies = new Map<string, Array<{ status: number; body: unknown }>>();

  #forced(fragment: string, send: (status: number, body: unknown) => void): boolean {
    const next = this.forcedReplies.get(fragment)?.shift();
    if (!next) return false;
    send(next.status, next.body);
    return true;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.#handle(req, res));
    this.server.listen(0, "127.0.0.1");
    await new Promise<void>((r) => this.server.once("listening", () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }

  register(controllerKey: string, keyId: string): void {
    this.controllerKey = controllerKey;
    this.keyId = keyId;
  }

  /** Verifies the controller envelope; returns an error string or null. */
  verifyEnvelope(method: string, path: string, headers: IncomingMessage["headers"], raw: Buffer): string | null {
    const h = (n: string) => (typeof headers[n] === "string" ? (headers[n] as string) : undefined);
    const keyId = h(CONTROLLER_HEADERS.keyId);
    const timestamp = h(CONTROLLER_HEADERS.timestamp);
    const nonce = h(CONTROLLER_HEADERS.nonce);
    const signature = h(CONTROLLER_HEADERS.signature);
    if (!keyId || !timestamp || !nonce || !signature) return "missing controller headers";
    if (keyId !== this.keyId || !this.controllerKey) return "unknown controller";
    if (Math.abs(Date.now() - Date.parse(timestamp)) > CONTROLLER_REQUEST_MAX_SKEW_MS) return "stale request";
    const message = controllerSigningMessage({ method, path, bodyDigest: createHash("sha256").update(raw).digest("hex"), timestamp, nonce, keyId });
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(getAddressEncoder().encode(address(this.controllerKey))).toString("base64url") }, format: "jwk" });
    const ok = verify(null, Buffer.from(message, "utf8"), pub, Buffer.from(getBase58Encoder().encode(signature)));
    if (!ok) {
      this.badSignatures += 1;
      return "bad signature";
    }
    const k = `${keyId}:${nonce}`;
    if (this.nonces.has(k)) {
      this.replays += 1;
      return "replayed nonce";
    }
    this.nonces.add(k);
    return null;
  }

  #verifyBy(signer: string, message: string, signature: string): boolean {
    try {
      const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(getAddressEncoder().encode(address(signer))).toString("base64url") }, format: "jwk" });
      return verify(null, Buffer.from(message, "utf8"), pub, Buffer.from(getBase58Encoder().encode(signature)));
    } catch {
      return false;
    }
  }

  #drop(fragment: string, res: ServerResponse): boolean {
    const n = this.dropReplies.get(fragment) ?? 0;
    if (n <= 0) return false;
    this.dropReplies.set(fragment, n - 1);
    res.socket?.destroy();
    return true;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const path = req.url ?? "/";
    const method = req.method ?? "GET";
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const body = raw.length > 0 ? (JSON.parse(raw.toString("utf8")) as unknown) : undefined;
    if (method === "GET" && path.startsWith("/marketplace/listings")) {
      this.calls.push({ method, path, body });
      send(200, { listings: this.catalog, label: "test" });
      return;
    }
    const problem = this.verifyEnvelope(method, path, req.headers, raw);
    if (problem) {
      send(problem === "replayed nonce" ? 409 : 401, { error: { code: "UNAUTHENTICATED", message: problem } });
      return;
    }
    this.calls.push({ method, path, body });
    let m: RegExpExecArray | null;
    if (method === "GET" && path === "/controller/payment-requests") {
      send(200, { requests: this.requests });
    } else if (method === "POST" && (m = /^\/controller\/payment-requests\/([^/]+)\/decision$/.exec(path))) {
      const op = decodeURIComponent(m[1] as string);
      this.decisions.set(op, [...(this.decisions.get(op) ?? []), body]);
      this.accepted.set(op, (body as { decision: string }).decision === "accepted");
      if (!this.#drop("decision", res)) send(200, { ok: true });
    } else if (method === "POST" && (m = /^\/controller\/payment-requests\/([^/]+)\/status$/.exec(path))) {
      const op = decodeURIComponent(m[1] as string);
      if (this.#forced("status", send)) return;
      const parsed = controllerStatusSchema.safeParse(body);
      if (!parsed.success) return send(400, { error: { code: "INVALID_REQUEST", message: "bad status" } });
      if (parsed.data.payer !== null) {
        const prior = this.payers.get(op);
        if (this.refusePayer) return send(409, { error: { code: "IDEMPOTENCY_CONFLICT", message: "payer refused" } });
        if (prior !== undefined && prior !== parsed.data.payer) return send(409, { error: { code: "IDEMPOTENCY_CONFLICT", message: "payer already set" } });
        const quoteDigest = this.requests.find((r) => r.operationId === op)?.quote.quoteDigest ?? this.knownDigests.get(op);
        if (!quoteDigest || !this.#verifyBy(parsed.data.payer, payerBindingMessage(op, quoteDigest, parsed.data.payer), parsed.data.payerProof as string)) {
          this.badPayerProofs += 1;
          return send(403, { error: { code: "FORBIDDEN", message: "payer binding proof is invalid" } });
        }
        if (prior === undefined && this.accepted.get(op) !== true) return send(409, { error: { code: "INVALID_TRANSITION", message: "a payer can only be bound right after the controller accepts" } });
        if ([...this.payers.entries()].some(([o, p]) => o !== op && p === parsed.data.payer)) return send(409, { error: { code: "IDEMPOTENCY_CONFLICT", message: "payer bound to another operation" } });
        if (this.applyPayer) this.payers.set(op, parsed.data.payer);
      }
      this.statuses.set(op, [...(this.statuses.get(op) ?? []), body]);
      if (!this.#drop("status", res)) send(200, { ok: true });
    } else if (method === "POST" && (m = /^\/controller\/payments\/([^/]+)\/evidence$/.exec(path))) {
      const op = decodeURIComponent(m[1] as string);
      const b = body as { operationId: string; signature: string };
      if (this.#forced("evidence", send)) return;
      if (!this.payers.has(op)) {
        this.pendingEvidence += 1;
        return send(202, { operationId: op, state: "pending_payer" });
      }
      const prior = this.evidence.get(op);
      if (prior && prior.signature !== b.signature) {
        send(409, { error: { code: "IDEMPOTENCY_CONFLICT", message: "different evidence" } });
        return;
      }
      this.evidence.set(op, { signature: b.signature, deliveries: (prior?.deliveries ?? 0) + 1 });
      if (!this.#drop("evidence", res)) send(200, { operationId: op, state: "settled" });
    } else if (method === "POST" && path === "/controller/hires") {
      this.hires.push(body);
      if (!this.#drop("hires", res)) send(200, { jobId: "00000000-0000-4000-8000-0000000000aa", operationId: "op_from_marketplace", quote: {}, existing: false });
    } else {
      send(404, { error: { code: "NOT_FOUND", message: "no such endpoint" } });
    }
  }
}
