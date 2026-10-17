import { Router, type Request, type Response } from "express";
import { isAddress } from "@solana/kit";
import { z } from "zod";
import { baseUnitString } from "@veilo/contracts";
import { ControlError } from "../errors";
import type { Integration } from "../integration";
import { approveExternalBinding, disableExternalBinding, listExternalBindings, type ExternalBindingRow } from "../external/bindings";
import { getPurchaseRow } from "../ledger/purchases";
import { actorOf, requireActor, type AuthDeps } from "./actor";

const bindingSchema = z
  .object({
    label: z.string().min(1).max(80),
    origin: z.string().min(1).max(200),
    resourcePath: z.string().min(1).max(210),
    network: z.string().min(1),
    mint: z.string().refine(isAddress, "mint must be a base58 address"),
    payTo: z.string().refine(isAddress, "payTo must be a base58 address"),
    payToAta: z.string().refine(isAddress, "payToAta must be a base58 address"),
    unitPriceUsdc: baseUnitString,
    maxCalls: z.number().int().min(1).max(100),
    allowedFeePayers: z.array(z.string().refine(isAddress, "fee payer must be a base58 address")).min(1).max(4),
    allowedRpcMethods: z.array(z.string()).min(1).max(32).optional(),
  })
  .strict();

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw new ControlError("INVALID_REQUEST", r.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; "));
  return r.data;
}

const idParam = (req: Request, name: string): string => {
  const v = req.params[name];
  if (typeof v !== "string" || !/^[0-9a-f-]{36}$/.test(v)) throw new ControlError("NOT_FOUND", "resource not found");
  return v;
};

export function bindingView(b: ExternalBindingRow): Record<string, unknown> {
  return {
    id: b.id,
    serviceId: b.service_id,
    label: b.label,
    origin: b.origin,
    resourcePath: b.resource_path,
    network: b.network,
    mint: b.mint,
    payTo: b.pay_to,
    payToAta: b.pay_to_ata,
    unitPrice: { amount: b.unit_price_usdc.toString(), unit: "usdc_base_units" },
    maxCalls: Number(b.max_calls),
    allowedFeePayers: JSON.parse(b.allowed_fee_payers_json) as string[],
    allowedRpcMethods: b.allowed_rpc_methods_json === null ? null : (JSON.parse(b.allowed_rpc_methods_json) as string[]),
    status: b.status,
  };
}

/**
 * Owner approval of external x402 resources. Approval is the only way a binding exists; agents
 * can buy from an approved binding within their policy but can never create or widen one.
 */
export function externalRouter(deps: AuthDeps & { integration?: Integration | undefined; maxExternalBatchUsdc?: bigint }): Router {
  const { ledger } = deps;
  const r = Router();
  const owner = requireActor(deps, ["owner"]);
  const ownerOf = (res: Response) => {
    const a = actorOf(res);
    if (a.kind !== "owner") throw new ControlError("FORBIDDEN", "owner session required");
    return a;
  };
  const runner = () => {
    const x = deps.integration?.external;
    if (!x) throw new ControlError("NOT_READY", "external x402 purchases are not configured");
    return x;
  };

  r.get("/external-bindings", owner, (_req, res) => {
    const o = ownerOf(res);
    res.json({ bindings: listExternalBindings(ledger, o.workspaceId).map(bindingView) });
  });

  r.post("/external-bindings", owner, async (req, res) => {
    const o = ownerOf(res);
    const b = parse(bindingSchema, req.body);
    const row = await approveExternalBinding(
      ledger,
      o.workspaceId,
      o.ownerPubkey,
      { ...b, unitPriceUsdc: BigInt(b.unitPriceUsdc) },
      runner().deps.origins,
      deps.maxExternalBatchUsdc ?? 100_000n,
    );
    res.status(201).json({ binding: bindingView(row) });
  });

  r.post("/external-bindings/:id/disable", owner, (req, res) => {
    const o = ownerOf(res);
    res.json({ binding: bindingView(disableExternalBinding(ledger, o.workspaceId, o.ownerPubkey, idParam(req, "id"))) });
  });

  r.get("/purchases/:id/external-calls", owner, (req, res) => {
    const o = ownerOf(res);
    const p = getPurchaseRow(ledger, idParam(req, "id"));
    if (p.workspace_id !== o.workspaceId) throw new ControlError("NOT_FOUND", "resource not found");
    res.json(runner().result(p.id));
  });

  r.get("/purchases/:id/external-calls/:index/response", owner, (req, res) => {
    const o = ownerOf(res);
    const p = getPurchaseRow(ledger, idParam(req, "id"));
    if (p.workspace_id !== o.workspaceId) throw new ControlError("NOT_FOUND", "resource not found");
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0 || index > 99) throw new ControlError("NOT_FOUND", "resource not found");
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    res.json({ untrusted: true, response: runner().response(p.id, index) });
  });

  return r;
}
