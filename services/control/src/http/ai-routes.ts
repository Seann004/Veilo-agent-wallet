import { Router, type Response } from "express";
import { z } from "zod";
import type { AiService } from "../ai/service";
import { ControlError } from "../errors";
import { actorOf, requireActor, type AuthDeps } from "./actor";

const providerSchema = z
  .object({
    provider: z.enum(["openrouter", "anthropic", "openai", "openai_compatible"]),
    apiKey: z.string().min(1).max(400),
    model: z.string().min(1).max(200),
    baseUrl: z.string().max(300).optional(),
  })
  .strict();

/**
 * The owner's model provider. The key is accepted once and never returned: reads show only the
 * provider, model and the key's last four characters.
 */
export function aiRouter(deps: AuthDeps & { ai?: AiService | undefined }): Router {
  const r = Router();
  const owner = requireActor(deps, ["owner"]);
  const ownerOf = (res: Response) => {
    const a = actorOf(res);
    if (a.kind !== "owner") throw new ControlError("FORBIDDEN", "owner session required");
    return a;
  };
  const ai = () => {
    if (!deps.ai) throw new ControlError("NOT_READY", "model provider settings are not available");
    return deps.ai;
  };

  r.get("/ai-provider", owner, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ provider: ai().view(ownerOf(res).workspaceId) });
  });

  r.put("/ai-provider", owner, (req, res) => {
    const o = ownerOf(res);
    const b = providerSchema.safeParse(req.body ?? {});
    if (!b.success) throw new ControlError("INVALID_REQUEST", "provider, apiKey and model are required");
    res.setHeader("Cache-Control", "no-store");
    res.json({ provider: ai().set(o.workspaceId, o.ownerPubkey, b.data) });
  });

  r.delete("/ai-provider", owner, (_req, res) => {
    const o = ownerOf(res);
    ai().clear(o.workspaceId, o.ownerPubkey);
    res.status(204).end();
  });

  r.post("/ai-provider/test", owner, async (_req, res) => {
    res.json(await ai().test(ownerOf(res).workspaceId));
  });

  return r;
}
