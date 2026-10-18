import { Router, type Response } from "express";
import { z } from "zod";
import type { ChannelService } from "../channels/service";
import { ControlError } from "../errors";
import { actorOf, requireActor, type AuthDeps } from "./actor";

const label = z.string().min(1).max(80);
const addSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("telegram"), label, botToken: z.string().min(1).max(100), chatId: z.string().min(1).max(30) }).strict(),
  z.object({ kind: z.literal("slack"), label, webhookUrl: z.string().min(1).max(300) }).strict(),
  z.object({ kind: z.literal("discord"), label, webhookUrl: z.string().min(1).max(300) }).strict(),
]);

/** Owner-only destinations for agents' finished results. Secrets go in once and never come back. */
export function channelRouter(deps: AuthDeps & { channels?: ChannelService | undefined }): Router {
  const r = Router();
  const owner = requireActor(deps, ["owner"]);
  const ownerOf = (res: Response) => {
    const a = actorOf(res);
    if (a.kind !== "owner") throw new ControlError("FORBIDDEN", "owner session required");
    return a;
  };
  const channels = () => {
    if (!deps.channels) throw new ControlError("NOT_READY", "result delivery is not available");
    return deps.channels;
  };
  const id = (v: unknown) => {
    const p = z.uuid().safeParse(v);
    if (!p.success) throw new ControlError("INVALID_REQUEST", "unknown destination");
    return p.data;
  };

  r.get("/channels", owner, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ channels: channels().list(ownerOf(res).workspaceId) });
  });

  r.post("/channels", owner, (req, res) => {
    const b = addSchema.safeParse(req.body ?? {});
    if (!b.success) throw new ControlError("INVALID_REQUEST", "kind, label and the service's details are required");
    const o = ownerOf(res);
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json({ channel: channels().add(o.workspaceId, o.ownerPubkey, b.data) });
  });

  r.delete("/channels/:id", owner, (req, res) => {
    const o = ownerOf(res);
    channels().remove(o.workspaceId, o.ownerPubkey, id(req.params.id));
    res.status(204).end();
  });

  r.post("/channels/:id/test", owner, async (req, res) => {
    res.json(await channels().test(ownerOf(res).workspaceId, id(req.params.id)));
  });

  r.post("/channels/telegram/chats", owner, async (req, res) => {
    const b = z.object({ botToken: z.string().min(1).max(100) }).strict().safeParse(req.body ?? {});
    if (!b.success) throw new ControlError("INVALID_REQUEST", "botToken is required");
    ownerOf(res);
    res.setHeader("Cache-Control", "no-store");
    res.json({ chats: await channels().telegramChats(b.data.botToken) });
  });

  r.put("/agents/:id/delivery", owner, (req, res) => {
    const b = z.object({ channelId: z.uuid().nullable() }).strict().safeParse(req.body ?? {});
    if (!b.success) throw new ControlError("INVALID_REQUEST", "channelId must be a destination id or null");
    const o = ownerOf(res);
    const agentId = z.uuid().safeParse(req.params.id);
    if (!agentId.success) throw new ControlError("NOT_FOUND", "agent not found");
    channels().bind(o.workspaceId, o.ownerPubkey, agentId.data, b.data.channelId);
    res.status(204).end();
  });

  return r;
}
