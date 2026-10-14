import express, { type Express } from "express";
import { healthReport, type ServiceHealth } from "@veilo/contracts";

export function createApp(health: ServiceHealth): Express {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) => {
    const report = healthReport(health);
    res.status(report.status === "ok" ? 200 : 503).json(report);
  });
  return app;
}
