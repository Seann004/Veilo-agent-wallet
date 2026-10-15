import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { baseUnits } from "@veilo/contracts";
import { ControlError } from "../errors";
import { authenticateSession, safeEqualHex, sha256Hex } from "../auth/session";
import { getPurchaseRow, purchaseView } from "../ledger/purchases";
import {
  confirmWalletChange,
  liveReleasedPurchases,
  markWalletNoteExited,
  noteRefs,
  registerWalletDepositNote,
  walletMarkRecoverable,
  walletRecordMerchantExpired,
  walletRecordRecovery,
} from "../ledger/wallet-bridge";
import { actorOf, requireActor, type AuthDeps } from "./actor";

const hex32 = z.string().regex(/^[0-9a-f]{64}$/);

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    throw new ControlError("INVALID_REQUEST", r.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; "));
  }
  return r.data;
}

const purchaseParam = (req: Request): string => {
  const v = req.params.id;
  if (typeof v !== "string" || !/^[0-9a-f-]{36}$/.test(v)) throw new ControlError("NOT_FOUND", "resource not found");
  return v;
};

/**
 * Internal routes for the wallet service only (its service credential). They carry public note
 * references and chain evidence; owner identity is resolved here so the wallet never stores
 * owner sessions itself.
 */
export function walletInternalRouter(deps: AuthDeps): Router {
  const { ledger } = deps;
  const r = Router();
  const service = requireActor(deps, ["service"]);
  const walletOnly = (_req: Request, res: Response, next: () => void) => {
    const a = actorOf(res);
    if (a.kind !== "service" || a.service !== "wallet") throw new ControlError("FORBIDDEN", "wallet service credential required");
    next();
  };
  r.use("/internal/wallet", service, walletOnly);

  r.post("/internal/wallet/owner-session", (req, res) => {
    const body = parse(z.object({ sessionToken: z.string().min(1).max(256), csrfToken: z.string().max(256).optional() }).strict(), req.body);
    const s = authenticateSession(ledger, body.sessionToken);
    if (!s) throw new ControlError("UNAUTHENTICATED", "owner session is not valid");
    const csrfValid = body.csrfToken !== undefined && safeEqualHex(sha256Hex(body.csrfToken), s.csrfHash);
    res.json({ workspaceId: s.workspaceId, ownerPubkey: s.ownerPubkey, csrfValid });
  });

  r.get("/internal/wallet/notes", (_req, res) => {
    res.json({ notes: noteRefs(ledger) });
  });

  r.post("/internal/wallet/notes", (req, res) => {
    const body = parse(z.object({ commitment: hex32, value: baseUnits }).strict(), req.body);
    if (body.value <= 0n) throw new ControlError("INVALID_REQUEST", "note value must be positive");
    const { note, created } = registerWalletDepositNote(ledger, body.commitment, body.value);
    res.status(created ? 201 : 200).json({ noteId: note.id, state: note.state });
  });

  r.post("/internal/wallet/notes/change-inserted", (req, res) => {
    const body = parse(z.object({ purchaseId: z.uuid() }).strict(), req.body);
    const note = confirmWalletChange(ledger, body.purchaseId);
    res.json({ noteId: note.id, state: note.state });
  });

  r.post("/internal/wallet/notes/exited", (req, res) => {
    const body = parse(z.object({ commitment: hex32, observedAtMs: z.number().int().positive() }).strict(), req.body);
    const note = markWalletNoteExited(ledger, body.commitment, body.observedAtMs);
    res.json({ noteId: note.id, state: note.state });
  });

  r.get("/internal/wallet/purchases/live", (_req, res) => {
    res.json({ purchases: liveReleasedPurchases(ledger) });
  });

  r.post("/internal/wallet/purchases/:id/recoverable", (req, res) => {
    const body = parse(z.object({ reason: z.string().min(1).max(200) }).strict(), req.body);
    const p = walletMarkRecoverable(ledger, purchaseParam(req), body.reason);
    res.json({ purchase: purchaseView(ledger, p) });
  });

  r.post("/internal/wallet/purchases/:id/merchant-expired", (req, res) => {
    parse(z.object({}).strict(), req.body);
    res.json({ purchase: purchaseView(ledger, walletRecordMerchantExpired(ledger, purchaseParam(req))) });
  });

  r.post("/internal/wallet/purchases/:id/recovered", (req, res) => {
    const body = parse(
      z
        .object({
          recoveredPrincipal: baseUnits,
          tokenFeesPaid: baseUnits,
          sponsorLamportsSpent: baseUnits,
          observedAtMs: z.number().int().positive(),
        })
        .strict(),
      req.body,
    );
    const p = walletRecordRecovery(ledger, purchaseParam(req), body);
    res.json({ purchase: purchaseView(ledger, p) });
  });

  r.get("/internal/wallet/purchases/:id", (req, res) => {
    res.json({ purchase: purchaseView(ledger, getPurchaseRow(ledger, purchaseParam(req))) });
  });

  return r;
}
