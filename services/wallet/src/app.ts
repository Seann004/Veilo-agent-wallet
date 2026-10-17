import { createHash, timingSafeEqual } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { address, isAddress } from "@solana/kit";
import { z } from "zod";
import {
  baseUnits,
  externalCallRequestWire,
  fundingBindingWire,
  fundingRequestWire,
  healthReport,
  payerBindingRequestWire,
  type ServiceHealth,
} from "@veilo/contracts";
import { EncodingError } from "@veilo/privacy-sdk";
import { ServiceCallError } from "./adapters";
import { WalletError } from "./errors";
import type { FundingService } from "./funding";
import type { NoteService } from "./notes";
import type { OwnerFlows } from "./owner-flows";
import { PortUnavailableError, type ControlPort } from "./ports";

export interface WalletAppDeps {
  funding: FundingService;
  notes: NoteService;
  owner: OwnerFlows;
  control: ControlPort;
  /** Digest of the control service credential allowed to drive funding. */
  controlCredentialDigest: string | null;
  /** Origin of the owner dashboard; browser requests from elsewhere are refused. */
  dashboardOrigin: string;
  /** False until startup reconciliation has finished. */
  isReady: () => boolean;
  log?: (line: string) => void;
}

const sha = (v: string) => createHash("sha256").update(v, "utf8").digest();
const SESSION_COOKIE = "veilo_session";

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw new WalletError("INVALID_REQUEST", r.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; "));
  return r.data;
}

const uuidParam = (req: Request, name: string): string => {
  const v = req.params[name];
  if (typeof v !== "string" || !/^[0-9a-f-]{36}$/.test(v)) throw new WalletError("NOT_FOUND", "resource not found");
  return v;
};

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export function createApp(health: ServiceHealth, deps?: WalletAppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) => {
    const report = healthReport(health);
    res.status(report.status === "ok" ? 200 : 503).json(report);
  });
  if (!deps) return app;
  const log = deps.log ?? ((l: string) => console.log(l));
  // Method, path and status only: bodies carry proofs and signed payments, headers carry credentials.
  app.use((req, res, next) => {
    res.on("finish", () => log(`[wallet] ${req.method} ${req.path} ${res.statusCode}`));
    next();
  });
  app.use(express.json({ limit: "256kb", strict: true }));

  const service = (req: Request, _res: Response, next: NextFunction) => {
    const m = /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? "");
    if (!m || deps.controlCredentialDigest === null) throw new WalletError("UNAUTHENTICATED", "control service credential required");
    const got = sha(m[1]!);
    const want = Buffer.from(deps.controlCredentialDigest, "hex");
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new WalletError("UNAUTHENTICATED", "control service credential required");
    next();
  };
  const ready = (_req: Request, _res: Response, next: NextFunction) => {
    if (!deps.isReady()) throw new WalletError("NOT_READY", "startup reconciliation has not finished");
    next();
  };
  const owner = async (req: Request, res: Response, next: NextFunction) => {
    const token = readCookie(req, SESSION_COOKIE) ?? (typeof req.headers["x-veilo-owner-session"] === "string" ? req.headers["x-veilo-owner-session"] : undefined);
    if (!token) throw new WalletError("UNAUTHENTICATED", "owner session required");
    const csrf = typeof req.headers["x-csrf-token"] === "string" ? req.headers["x-csrf-token"] : undefined;
    const s = await deps.control.ownerSession(token, csrf);
    if (req.method !== "GET") {
      if (req.headers.origin !== undefined && req.headers.origin !== deps.dashboardOrigin) throw new WalletError("FORBIDDEN", "request origin is not allowed");
      if (!s.csrfValid) throw new WalletError("FORBIDDEN", "missing or invalid anti-CSRF token");
    }
    res.locals.owner = address(s.ownerPubkey);
    next();
  };
  const ownerOf = (res: Response) => res.locals.owner as ReturnType<typeof address>;

  // Funding API driven by control (contract: @veilo/contracts FundingProvider).
  app.post("/fundings", service, ready, async (req, res) => {
    const b = parse(fundingRequestWire, req.body);
    res.json(
      wireFunding(
        await deps.funding.prepare({
          purchaseId: b.purchaseId,
          operationId: b.operationId,
          payoutUsdc: BigInt(b.payoutUsdc),
          tokenFeeCapUsdc: BigInt(b.tokenFeeCapUsdc),
          sponsorLamportCap: BigInt(b.sponsorLamportCap),
          inputNote: { commitment: b.inputNote.commitment, value: BigInt(b.inputNote.value) },
          binding: b.binding,
        }),
      ),
    );
  });
  app.post("/fundings/:purchaseId/release", service, ready, async (req, res) => {
    const b = parse(z.object({ fundingRef: z.string().min(1) }).strict(), req.body);
    res.json(wireFunding(await deps.funding.release(uuidParam(req, "purchaseId"), b.fundingRef)));
  });
  app.get("/fundings/:purchaseId", service, async (req, res) => {
    res.json(wireFunding(await deps.funding.status(uuidParam(req, "purchaseId"))));
  });
  app.post("/fundings/:purchaseId/payer-binding", service, ready, async (req, res) => {
    const b = parse(payerBindingRequestWire, req.body);
    res.setHeader("Cache-Control", "no-store");
    res.json(await deps.funding.signPayerBinding(uuidParam(req, "purchaseId"), b));
  });
  app.post("/fundings/:purchaseId/merchant-payment", service, ready, async (req, res) => {
    const b = parse(
      z.object({ fundingRef: z.string().min(1), paymentRequired: z.unknown(), binding: fundingBindingWire, exactAmountUsdc: baseUnits }).strict(),
      req.body,
    );
    res.setHeader("Cache-Control", "no-store");
    res.json(await deps.funding.signMerchant(uuidParam(req, "purchaseId"), { fundingRef: b.fundingRef, paymentRequired: b.paymentRequired, binding: b.binding, exactAmountUsdc: b.exactAmountUsdc }));
  });

  app.post("/fundings/:purchaseId/external-calls", service, ready, async (req, res) => {
    const b = parse(externalCallRequestWire, req.body);
    res.setHeader("Cache-Control", "no-store");
    res.json(await deps.funding.signExternalCall({ purchaseId: uuidParam(req, "purchaseId"), ...b }));
  });
  app.get("/fundings/:purchaseId/external-calls/:callIndex", service, async (req, res) => {
    const index = Number(req.params.callIndex);
    if (!Number.isInteger(index) || index < 0 || index > 99) throw new WalletError("INVALID_REQUEST", "invalid call index");
    res.json(await deps.funding.externalCallOutcome(uuidParam(req, "purchaseId"), index));
  });

  // Owner wallet API.
  app.post("/deposits/prepare", owner, async (req, res) => {
    const b = parse(z.object({ amount: baseUnits }).strict(), req.body);
    res.status(201).json(await deps.notes.prepareDeposit(ownerOf(res), b.amount));
  });
  app.post("/deposits/register", owner, (req, res) => {
    const b = parse(z.object({ depositId: z.uuid(), signature: z.string() }).strict(), req.body);
    res.json(deps.notes.registerDeposit(ownerOf(res), b.depositId, b.signature));
  });
  app.get("/notes/status", owner, async (_req, res) => {
    const sync = await deps.notes.sync();
    res.json({ ...deps.notes.status(), sync });
  });
  app.post("/exits/prepare", owner, async (req, res) => {
    const b = parse(z.object({ noteId: z.uuid() }).strict(), req.body);
    res.status(201).json(await deps.owner.prepareExit(ownerOf(res), b.noteId));
  });
  app.post("/exits/register", owner, (req, res) => {
    const b = parse(z.object({ exitId: z.uuid(), signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/) }).strict(), req.body);
    res.json(deps.owner.registerExit(ownerOf(res), b.exitId, b.signature));
  });
  // The destination is never taken from the request: only the configured owner recovery account.
  app.post("/recovery/prepare", owner, async (req, res) => {
    const b = parse(z.object({ purchaseId: z.uuid() }).strict(), req.body);
    res.status(201).json(await deps.owner.prepareRecovery(b.purchaseId));
  });
  app.post("/recovery/:id/confirm", owner, async (req, res) => {
    parse(z.object({}).strict(), req.body);
    res.json(await deps.owner.confirmRecovery(uuidParam(req, "id")));
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "no such endpoint" } });
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof WalletError) return void res.status(error.status).json({ error: { code: error.code, message: error.message } });
    if (error instanceof ServiceCallError) {
      const status = error.status >= 400 && error.status < 600 ? error.status : 502;
      return void res.status(status).json({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof PortUnavailableError) return void res.status(503).json({ error: { code: "NOT_READY", message: error.message } });
    if (error instanceof EncodingError) return void res.status(400).json({ error: { code: "INVALID_REQUEST", message: error.message } });
    const e = error as { type?: string; name?: string; message?: string };
    if (e.type === "entity.parse.failed" || e.type === "entity.too.large") {
      return void res.status(400).json({ error: { code: "INVALID_REQUEST", message: "request body is not valid JSON within size limits" } });
    }
    log(`[wallet] unhandled ${e.name ?? "Error"}`);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "internal error" } });
  });
  return app;
}

function wireFunding(r: Awaited<ReturnType<FundingService["status"]>>): unknown {
  if (r.status !== "finalized") return r;
  return {
    status: "finalized",
    fundingRef: r.fundingRef,
    evidence: {
      payout: r.evidence.payout.toString(),
      tokenFees: r.evidence.tokenFees.toString(),
      change: r.evidence.change.toString(),
      changeCommitment: r.evidence.changeCommitment,
      observedAtMs: r.evidence.observedAtMs,
      signature: r.evidence.signature,
      sponsorLamportsSpent: r.evidence.sponsorLamportsSpent.toString(),
    },
  };
}

export const isOwnerRecoveryAddress = (v: string | undefined): v is string => v !== undefined && isAddress(v);
