import { randomUUID } from "node:crypto";
import { immediate } from "@veilo/db";
import type { ProviderKeyVault } from "../ai/vault";
import { num, type Ledger } from "../context";
import { ControlError } from "../errors";
import { writeAudit } from "../ledger/events";
import { getAgent } from "../ledger/workspace";

export type ChannelKind = "telegram" | "slack" | "discord";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface ChannelRow {
  id: string;
  workspace_id: string;
  kind: ChannelKind;
  label: string;
  secret_ciphertext: string;
  hint: string;
  created_at_ms: bigint;
}

type Secret = { kind: "telegram"; token: string; chatId: string } | { kind: "slack" | "discord"; webhookUrl: string };

export type ChannelInput =
  | { kind: "telegram"; label: string; botToken: string; chatId: string }
  | { kind: "slack" | "discord"; label: string; webhookUrl: string };

const SEAL_PURPOSE = "delivery-channel";
const TELEGRAM_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;
const TELEGRAM_CHAT = /^-?\d{1,20}$/;
const MAX_TEXT: Record<ChannelKind, number> = { telegram: 3_800, slack: 3_800, discord: 1_900 };

/**
 * Webhook URLs are accepted only on the services' own fixed hosts and paths, so a stored
 * destination can never point a request at anything else.
 */
export function webhookProblem(kind: "slack" | "discord", raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "not a URL";
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port !== "" || u.search || u.hash) return "use the webhook URL exactly as the service gives it";
  if (kind === "slack") return u.hostname === "hooks.slack.com" && /^\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/.test(u.pathname) ? null : "not a Slack incoming webhook URL (https://hooks.slack.com/services/…)";
  return (u.hostname === "discord.com" || u.hostname === "discordapp.com") && /^\/api\/webhooks\/\d{5,25}\/[A-Za-z0-9_-]{20,100}$/.test(u.pathname)
    ? null
    : "not a Discord webhook URL (https://discord.com/api/webhooks/…)";
}

/** Slack reads <, > and & as markup and mentions; escaped, the text is shown as written. */
const slackText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Owner chats that receive agents' finished results: a Telegram bot chat, a Slack or a Discord
 * channel webhook. Secrets are sealed with the control vault and never returned. Agents cannot
 * reach this: control sends one message when a task finishes, to the destination the owner set
 * for that agent, and only to the service's own API host.
 */
export class ChannelService {
  readonly #fetch: FetchLike;

  constructor(
    private readonly ledger: Ledger,
    private readonly vault: ProviderKeyVault,
    fetchImpl?: FetchLike,
    private readonly dashboardOrigin = "",
  ) {
    this.#fetch = fetchImpl ?? ((u, i) => fetch(u, i));
  }

  list(workspaceId: string): Array<Record<string, unknown>> {
    const rows = this.ledger.db.prepare(`SELECT * FROM delivery_channel WHERE workspace_id = ? ORDER BY created_at_ms`).all(workspaceId) as ChannelRow[];
    const bindings = this.ledger.db
      .prepare(`SELECT d.agent_id, d.channel_id FROM agent_delivery d JOIN agent a ON a.id = d.agent_id WHERE a.workspace_id = ?`)
      .all(workspaceId) as Array<{ agent_id: string; channel_id: string }>;
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      label: r.label,
      hint: r.hint,
      createdAt: new Date(num(r.created_at_ms)).toISOString(),
      agentIds: bindings.filter((b) => b.channel_id === r.id).map((b) => b.agent_id),
    }));
  }

  add(workspaceId: string, ownerId: string, input: ChannelInput): Record<string, unknown> {
    const label = input.label.trim();
    if (label.length < 1 || label.length > 80) throw new ControlError("INVALID_REQUEST", "label must be 1 to 80 characters");
    let secret: Secret;
    let hint: string;
    if (input.kind === "telegram") {
      const token = input.botToken.trim();
      const chatId = input.chatId.trim();
      if (!TELEGRAM_TOKEN.test(token)) throw new ControlError("INVALID_REQUEST", "that does not look like a Telegram bot token from @BotFather");
      if (!TELEGRAM_CHAT.test(chatId)) throw new ControlError("INVALID_REQUEST", "chat ID must be a number (use Find my chat)");
      secret = { kind: "telegram", token, chatId };
      hint = `chat …${chatId.slice(-4)}`;
    } else {
      const url = input.webhookUrl.trim();
      const problem = webhookProblem(input.kind, url);
      if (problem) throw new ControlError("INVALID_REQUEST", problem);
      secret = { kind: input.kind, webhookUrl: url };
      hint = `webhook …${url.slice(-4)}`;
    }
    const id = randomUUID();
    immediate(this.ledger.db, () => {
      this.ledger.db
        .prepare(`INSERT INTO delivery_channel (id, workspace_id, kind, label, secret_ciphertext, hint, created_by, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, workspaceId, input.kind, label, this.vault.seal(workspaceId, JSON.stringify(secret), SEAL_PURPOSE), hint, ownerId, this.ledger.now());
      writeAudit(this.ledger, { workspaceId, scope: "delivery", actorType: "owner", actorId: ownerId, action: "channel.add", policyResult: "allowed", details: { channelId: id, kind: input.kind } });
    });
    return this.list(workspaceId).find((c) => c.id === id)!;
  }

  remove(workspaceId: string, ownerId: string, id: string): void {
    immediate(this.ledger.db, () => {
      this.#row(workspaceId, id);
      this.ledger.db.prepare(`DELETE FROM agent_delivery WHERE channel_id = ?`).run(id);
      this.ledger.db.prepare(`DELETE FROM delivery_channel WHERE id = ?`).run(id);
      writeAudit(this.ledger, { workspaceId, scope: "delivery", actorType: "owner", actorId: ownerId, action: "channel.remove", policyResult: "allowed", details: { channelId: id } });
    });
  }

  /** Sets or clears where one agent's finished results go. */
  bind(workspaceId: string, ownerId: string, agentId: string, channelId: string | null): void {
    immediate(this.ledger.db, () => {
      const agent = getAgent(this.ledger, agentId);
      if (!agent || agent.workspace_id !== workspaceId) throw new ControlError("NOT_FOUND", "agent not found");
      if (channelId === null) this.ledger.db.prepare(`DELETE FROM agent_delivery WHERE agent_id = ?`).run(agentId);
      else {
        this.#row(workspaceId, channelId);
        this.ledger.db
          .prepare(`INSERT INTO agent_delivery (agent_id, channel_id, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET channel_id = excluded.channel_id, updated_at_ms = excluded.updated_at_ms`)
          .run(agentId, channelId, this.ledger.now());
      }
      writeAudit(this.ledger, { workspaceId, scope: `agent:${agentId}`, actorType: "owner", actorId: ownerId, action: "channel.bind", policyResult: "allowed", details: { channelId } });
    });
  }

  async test(workspaceId: string, id: string): Promise<{ ok: true }> {
    const row = this.#row(workspaceId, id);
    await this.#send(row, "Veilo is connected. Your agents' finished results will arrive here.");
    return { ok: true };
  }

  /**
   * Chats a Telegram bot has seen recently, so the owner can pick theirs after messaging the
   * bot. The token is used for this one call and not stored.
   */
  async telegramChats(botToken: string): Promise<Array<{ chatId: string; title: string }>> {
    const token = botToken.trim();
    if (!TELEGRAM_TOKEN.test(token)) throw new ControlError("INVALID_REQUEST", "that does not look like a Telegram bot token from @BotFather");
    const res = await this.#call(`https://api.telegram.org/bot${token}/getUpdates`, { method: "GET" });
    const body = (await res.json().catch(() => null)) as { result?: Array<Record<string, { chat?: { id?: unknown; title?: unknown; username?: unknown; first_name?: unknown } }>> } | null;
    const chats = new Map<string, string>();
    for (const u of body?.result ?? []) {
      for (const v of Object.values(u)) {
        const c = typeof v === "object" && v ? v.chat : undefined;
        if (!c || (typeof c.id !== "number" && typeof c.id !== "string")) continue;
        const name = [c.title, c.username ? `@${String(c.username)}` : null, c.first_name].find((x) => typeof x === "string" && x.length > 0);
        chats.set(String(c.id), String(name ?? "Chat").slice(0, 80));
      }
    }
    return [...chats.entries()].map(([chatId, title]) => ({ chatId, title }));
  }

  /**
   * After a task finishes, sends its result to the agent's destination, once. Never throws:
   * the outcome is recorded on the task and in the audit log.
   */
  async deliverTask(taskId: string): Promise<void> {
    try {
      await this.#deliver(taskId);
    } catch (error) {
      // A ledger error here must not become an unhandled rejection that stops control.
      console.error(`[control] result delivery for task ${taskId} failed: ${(error as Error).name}`);
    }
  }

  async #deliver(taskId: string): Promise<void> {
    const ctx = immediate(this.ledger.db, () => {
      const task = this.ledger.db.prepare(`SELECT id, workspace_id, agent_id, state FROM task WHERE id = ?`).get(taskId) as
        | { id: string; workspace_id: string; agent_id: string; state: string }
        | undefined;
      if (!task || (task.state !== "completed" && task.state !== "incomplete")) return null;
      const binding = this.ledger.db.prepare(`SELECT channel_id FROM agent_delivery WHERE agent_id = ?`).get(task.agent_id) as { channel_id: string } | undefined;
      if (!binding) return null;
      const claimed = this.ledger.db
        .prepare(`INSERT INTO task_delivery (task_id, channel_id, outcome, at_ms) VALUES (?, ?, 'sending', ?) ON CONFLICT(task_id) DO NOTHING`)
        .run(task.id, binding.channel_id, this.ledger.now());
      if (claimed.changes === 0) return null;
      const channel = this.ledger.db.prepare(`SELECT * FROM delivery_channel WHERE id = ?`).get(binding.channel_id) as ChannelRow;
      const agent = getAgent(this.ledger, task.agent_id)!;
      const artifacts = this.ledger.db
        .prepare(
          `SELECT a.title, r.content FROM artifact a JOIN artifact_revision r ON r.artifact_id = a.id AND r.revision = a.current_revision
           WHERE a.task_id = ? AND a.agent_id = ? ORDER BY a.created_at_ms`,
        )
        .all(task.id, task.agent_id) as Array<{ title: string; content: string }>;
      return { task, channel, agentName: agent.name, artifacts };
    });
    if (!ctx) return;
    const { task, channel, agentName, artifacts } = ctx;
    const head = `${agentName} ${task.state === "completed" ? "finished a job" : "stopped part-way through a job"}.`;
    const body = artifacts.length === 0 ? "It saved no output." : artifacts.map((a) => `${a.title}\n\n${a.content}`).join("\n\n———\n\n");
    const link = this.dashboardOrigin ? `\n\nOpen in Veilo: ${this.dashboardOrigin}/outputs` : "";
    const room = MAX_TEXT[channel.kind] - head.length - link.length - 4;
    const text = `${head}\n\n${body.length > room ? `${body.slice(0, room - 1)}…` : body}${link}`;
    let outcome: "sent" | "failed" = "sent";
    let detail: string | null = null;
    try {
      await this.#send(channel, text);
    } catch (error) {
      outcome = "failed";
      detail = (error as Error).message.slice(0, 200);
    }
    immediate(this.ledger.db, () => {
      this.ledger.db.prepare(`UPDATE task_delivery SET outcome = ?, detail = ?, at_ms = ? WHERE task_id = ?`).run(outcome, detail, this.ledger.now(), task.id);
      writeAudit(this.ledger, {
        workspaceId: task.workspace_id,
        scope: `agent:${task.agent_id}`,
        actorType: "system",
        actorId: "control",
        action: "delivery.send",
        policyResult: "allowed",
        details: { taskId: task.id, channelId: channel.id, kind: channel.kind, outcome },
      });
    });
  }

  #row(workspaceId: string, id: string): ChannelRow {
    const row = this.ledger.db.prepare(`SELECT * FROM delivery_channel WHERE id = ? AND workspace_id = ?`).get(id, workspaceId) as ChannelRow | undefined;
    if (!row) throw new ControlError("NOT_FOUND", "destination not found");
    return row;
  }

  async #send(row: ChannelRow, text: string): Promise<void> {
    const secret = JSON.parse(this.vault.open(row.workspace_id, row.secret_ciphertext, SEAL_PURPOSE)) as Secret;
    if (secret.kind === "telegram") {
      // Plain text: no parse mode, so agent output is never read as formatting or links to preview.
      await this.#call(`https://api.telegram.org/bot${secret.token}/sendMessage`, {
        method: "POST",
        body: JSON.stringify({ chat_id: secret.chatId, text, disable_web_page_preview: true }),
      });
    } else if (secret.kind === "slack") {
      await this.#call(secret.webhookUrl, { method: "POST", body: JSON.stringify({ text: slackText(text), unfurl_links: false, unfurl_media: false }) });
    } else {
      await this.#call(secret.webhookUrl, { method: "POST", body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }) });
    }
  }

  /** One request to a fixed service host. Errors name the status only, never the URL (it holds the secret). */
  async #call(url: string, init: { method: string; body?: string }): Promise<Response> {
    let res: Response;
    try {
      res = await this.#fetch(url, { ...init, headers: { "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      throw new ControlError("PROVIDER_UNAVAILABLE", `the chat service could not be reached (${(error as Error).name})`);
    }
    if (!res.ok) throw new ControlError([400, 401, 403, 404].includes(res.status) ? "INVALID_REQUEST" : "PROVIDER_UNAVAILABLE", `the chat service refused the message (HTTP ${res.status})`);
    return res;
  }
}
