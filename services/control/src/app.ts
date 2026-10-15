import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { AmountError, healthReport, type ServiceHealth } from "@veilo/contracts";
import { ControlError } from "./errors";
import type { AuthDeps } from "./http/actor";
import { agentRouter } from "./http/agent-routes";
import { controlRouter } from "./http/routes";
import type { Integration } from "./integration";
import { walletInternalRouter } from "./http/wallet-internal";

export type LogSink = (line: string) => void;

export interface ControlDeps extends AuthDeps {
  log?: LogSink;
  /** Gateway, funding and scheduler integration; absent until configured. */
  integration?: Integration | undefined;
}

/**
 * Request logs carry method, path, status and duration only: never headers, cookies, bodies
 * or query strings, so credentials and signed material cannot reach them.
 */
function requestLog(log: LogSink) {
  return (req: Request, res: Response, next: NextFunction) => {
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
      log(`[control] ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
    });
    next();
  };
}

export function createApp(health: ServiceHealth, deps?: ControlDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("query parser", "simple");
  app.get("/health", (_req, res) => {
    const report = healthReport(health);
    res.status(report.status === "ok" ? 200 : 503).json(report);
  });
  if (!deps) return app;

  const log = deps.log ?? ((line: string) => console.log(line));
  app.use(requestLog(log));
  app.use(express.json({ limit: "256kb", strict: true }));
  app.use(walletInternalRouter(deps));
  app.use(controlRouter(deps));
  app.use(agentRouter(deps));
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "no such endpoint" } });
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ControlError) {
      res.status(error.status).json(error.toBody());
      return;
    }
    if (error instanceof AmountError) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: error.message } });
      return;
    }
    const e = error as { type?: string; status?: number; name?: string; message?: string };
    if (e.type === "entity.parse.failed" || e.type === "entity.too.large" || e.status === 400) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "request body is not valid JSON within size limits" } });
      return;
    }
    log(`[control] unhandled ${e.name ?? "Error"}: ${e.message ?? ""}`);
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "internal error" } });
  });
  return app;
}
