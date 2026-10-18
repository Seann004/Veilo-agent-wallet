import { createHash, timingSafeEqual } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { healthReport, type ServiceHealth } from "@veilo/contracts";
import { recoveryRequestWire, swapRequestWire, withdrawalRequestWire } from "@veilo/contracts/relayer";
import { EncodingError, ReplayMismatchError } from "@veilo/privacy-sdk";
import { sponsorTotals, type RelayerDb } from "./db";
import type { DeploymentStatus } from "./deployment";
import { IndexerError, type Indexer } from "./indexer";
import type { SwapService } from "./swaps";
import { RelayerError, type RecoveryService, type WithdrawalService } from "./withdrawals";

export interface RelayerAppDeps {
  db: RelayerDb;
  deployment: () => DeploymentStatus;
  indexer: () => Indexer | null;
  withdrawals: WithdrawalService;
  recoveries: RecoveryService;
  swaps: SwapService;
  /** Digest of the wallet service credential; only the wallet may submit material. */
  walletCredentialDigest: string | null;
  log?: (line: string) => void;
}

export function createApp(health: ServiceHealth, deps?: RelayerAppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) => {
    const report = healthReport(health);
    res.status(report.status === "ok" ? 200 : 503).json(report);
  });
  if (!deps) return app;
  const log = deps.log ?? ((l: string) => console.log(l));
  // Method, path and status only; request bodies (proofs, transactions) are never logged.
  app.use((req, res, next) => {
    res.on("finish", () => log(`[relayer] ${req.method} ${req.path} ${res.statusCode}`));
    next();
  });
  app.use(express.json({ limit: "64kb", strict: true }));

  const wallet = (req: Request, _res: Response, next: NextFunction) => {
    const m = /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? "");
    const want = deps.walletCredentialDigest === null ? null : Buffer.from(deps.walletCredentialDigest, "hex");
    const got = m ? createHash("sha256").update(m[1]!, "utf8").digest() : null;
    if (!want || !got || !timingSafeEqual(got, want)) throw new RelayerError("UNAUTHENTICATED", "wallet service credential required");
    next();
  };
  const parse = <S extends z.ZodType>(schema: S, v: unknown): z.infer<S> => {
    const r = schema.safeParse(v ?? {});
    // Field paths only; submitted values (which could include misplaced secrets) are not echoed.
    if (!r.success) throw new RelayerError("INVALID_REQUEST", r.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.code}`).join("; "));
    return r.data;
  };
  const idParam = (req: Request) => {
    const v = req.params.id;
    if (typeof v !== "string" || !/^[0-9a-f-]{36}$/.test(v)) throw new RelayerError("NOT_FOUND", "not found");
    return v;
  };

  app.get("/deployment", (_req, res) => {
    const d = deps.deployment();
    if (d.state === "verified") return void res.json({ state: "verified", manifest: d.manifest });
    res.status(503).json({ state: d.state, error: { code: "NOT_READY", message: d.reason } });
  });

  app.get("/public-state", async (_req, res) => {
    const indexer = deps.indexer();
    if (!indexer) throw new RelayerError("NOT_READY", "deployment is not verified; public state is unavailable");
    const { view } = await indexer.replay();
    res.json(view);
  });

  app.post("/withdrawals", wallet, async (req, res) => {
    const body = parse(withdrawalRequestWire, req.body);
    res.status(202).json(await deps.withdrawals.submit(body));
  });
  app.get("/withdrawals/:id", wallet, (req, res) => {
    const v = deps.withdrawals.view(idParam(req));
    if (!v) throw new RelayerError("NOT_FOUND", "withdrawal not found");
    res.json(v);
  });

  app.post("/recoveries", wallet, async (req, res) => {
    res.status(202).json(await deps.recoveries.submit(parse(recoveryRequestWire, req.body)));
  });
  app.post("/swaps", wallet, async (req, res) => {
    res.status(202).json(await deps.swaps.submit(parse(swapRequestWire, req.body)));
  });
  app.get("/swaps/:id", wallet, (req, res) => {
    const v = deps.swaps.view(idParam(req));
    if (!v) throw new RelayerError("NOT_FOUND", "swap not found");
    res.json(v);
  });
  app.get("/recoveries/:id", wallet, (req, res) => {
    const v = deps.recoveries.view(idParam(req));
    if (!v) throw new RelayerError("NOT_FOUND", "recovery not found");
    res.json(v);
  });

  app.get("/sponsor", wallet, (_req, res) => {
    const t = sponsorTotals(deps.db);
    res.json({ feesSpent: t.feesSpent.toString(), rentOutstanding: t.rentOutstanding.toString(), rentRecovered: t.rentRecovered.toString(), unit: "lamports" });
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "no such endpoint" } });
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof RelayerError) return void res.status(error.status).json({ error: { code: error.code, message: error.message } });
    if (error instanceof ReplayMismatchError || error instanceof IndexerError) {
      return void res.status(503).json({ error: { code: "NOT_READY", message: `public state refused: ${error.message}` } });
    }
    if (error instanceof EncodingError) return void res.status(400).json({ error: { code: "INVALID_REQUEST", message: error.message } });
    const e = error as { type?: string; name?: string };
    if (e.type === "entity.parse.failed" || e.type === "entity.too.large") {
      return void res.status(400).json({ error: { code: "INVALID_REQUEST", message: "request body is not valid JSON within size limits" } });
    }
    log(`[relayer] unhandled ${e.name ?? "Error"}`);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "internal error" } });
  });
  return app;
}
