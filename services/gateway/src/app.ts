import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { authenticateAccount } from "./auth";
import { GatewayError } from "./errors";
import type { Gateway } from "./gateway";
import { balanceView } from "./ledger/credits";
import type { HttpResult } from "./purchases";

type Handler = (req: Request) => Promise<HttpResult> | HttpResult;

function send(res: Response, result: HttpResult): void {
  for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value);
  res.setHeader("cache-control", "no-store");
  res.status(result.status).json(result.body);
}

function route(handler: Handler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => handler(req))
      .then((result) => send(res, result))
      .catch(next);
  };
}

export function createApp(gateway: Gateway): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  const account = (req: Request) => authenticateAccount(gateway.ctx.db, req.header("authorization"));
  const param = (req: Request, name: string) => String(req.params[name] ?? "");

  app.get("/health", (_req, res) => {
    const report = gateway.health();
    res.status(report.status === "ok" ? 200 : 503).json(report);
  });

  app.post("/quotes", route((req) => gateway.purchases.createQuote(account(req), req.body)));
  app.post(
    "/v1/purchases/:quoteId/execute",
    route((req) =>
      gateway.purchases.execute(account(req), param(req, "quoteId"), req.body, req.header("payment-signature") ?? undefined),
    ),
  );
  app.get("/v1/purchases/:quoteId/result", route((req) => gateway.purchases.result(account(req), param(req, "quoteId"))));

  app.get(
    "/credits/balance",
    route((req) => ({ status: 200, body: balanceView(gateway.ctx.db, account(req).id, gateway.ctx.now()) })),
  );
  app.post("/usage/authorize", route((req) => gateway.usage.authorize(account(req), req.body)));
  app.post("/usage/execute", route((req) => gateway.usage.execute(account(req), req.body)));
  app.get("/usage/:operationId", route((req) => gateway.usage.get(account(req), param(req, "operationId"))));
  app.post(
    "/usage/:operationId/release",
    route((req) => gateway.usage.releaseRequest(account(req), param(req, "operationId"), req.body)),
  );

  app.post("/planning/complete", route((req) => gateway.planning.complete(req.header("authorization"), req.body)));

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof GatewayError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof SyntaxError) {
      res.status(400).json({ error: { code: "BAD_REQUEST", message: "Malformed JSON body" } });
      return;
    }
    console.error(`[gateway] unhandled error: ${(error as Error).name}: ${(error as Error).message}`);
    res.status(500).json({ error: { code: "INTERNAL", message: "Internal gateway error" } });
  });
  return app;
}
