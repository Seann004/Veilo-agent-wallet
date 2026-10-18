import { Router, type Response } from "express";
import { z } from "zod";
import { baseUnitString, DEVNET_SOL_USDC_WHIRLPOOL } from "@veilo/contracts";
import { ControlError } from "../errors";
import { approveSwapService, disableSwapService, MAX_SWAP_USDC, SWAP_SERVICE_KEY, SWAP_SKU } from "../swap/service";
import { actorOf, requireActor, type AuthDeps } from "./actor";

/**
 * Owner approval of the devnet swap. Once approved and listed in an agent's allowed SKUs, the
 * agent may request any amount up to the approved maximum per swap, within its policy; it can
 * never change the pool, direction or destination.
 */
export function swapRouter(deps: AuthDeps): Router {
  const { ledger } = deps;
  const r = Router();
  const owner = requireActor(deps, ["owner"]);
  const ownerOf = (res: Response) => {
    const a = actorOf(res);
    if (a.kind !== "owner") throw new ControlError("FORBIDDEN", "owner session required");
    return a;
  };

  r.get("/swap-service", owner, (_req, res) => {
    const o = ownerOf(res);
    const row = ledger.db
      .prepare(
        `SELECT a.id, a.status, s.price_usdc FROM approved_service a JOIN service_sku s ON s.service_id = a.id AND s.sku = ?
         WHERE a.workspace_id = ? AND a.service_key = ?`,
      )
      .get(SWAP_SKU, o.workspaceId, SWAP_SERVICE_KEY) as { id: string; status: string; price_usdc: bigint } | undefined;
    res.json({
      sku: SWAP_SKU,
      whirlpool: DEVNET_SOL_USDC_WHIRLPOOL,
      maxAmount: { amount: MAX_SWAP_USDC.toString(), unit: "usdc_base_units" },
      service: row ? { id: row.id, status: row.status, amount: { amount: row.price_usdc.toString(), unit: "usdc_base_units" } } : null,
    });
  });

  r.post("/swap-service", owner, (req, res) => {
    const o = ownerOf(res);
    const b = z.object({ amountUsdc: baseUnitString }).strict().safeParse(req.body ?? {});
    if (!b.success) throw new ControlError("INVALID_REQUEST", "amountUsdc must be a base-unit string");
    res.status(201).json(approveSwapService(ledger, o.workspaceId, BigInt(b.data.amountUsdc), o.ownerPubkey));
  });

  r.delete("/swap-service", owner, (_req, res) => {
    const o = ownerOf(res);
    res.json(disableSwapService(ledger, o.workspaceId, o.ownerPubkey));
  });

  return r;
}
