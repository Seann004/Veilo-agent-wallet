import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderKeyVault } from "../src/ai/vault";
import { ChannelService, webhookProblem } from "../src/channels/service";
import { activateDefaults, createEnv, intentTask, type TestEnv } from "./helpers";

const BOT = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1";
const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXX";

let env: TestEnv;
afterEach(() => env?.ledger.db.close());

function recorder() {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    sent.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
    if (url.endsWith("/getUpdates")) return Response.json({ ok: true, result: [{ update_id: 1, message: { chat: { id: 4242, first_name: "Owner" } } }] });
    return Response.json({ ok: true });
  };
  return { sent, fetchImpl };
}

function finishedTask(agentId: string, state: "completed" | "incomplete" | "failed", content = "Answer with <@here> & a link https://example.com"): string {
  const taskId = intentTask(env, agentId, randomUUID());
  const now = env.ledger.now();
  env.ledger.db.prepare(`UPDATE task SET state = ? WHERE id = ?`).run(state, taskId);
  const artifactId = randomUUID();
  env.ledger.db
    .prepare(`INSERT INTO artifact (id, workspace_id, task_id, agent_id, kind, title, current_revision, review_state, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, 'research_brief', 'Fee brief', 1, 'needs_review', ?, ?)`)
    .run(artifactId, env.ws.id, taskId, agentId, now, now);
  env.ledger.db.prepare(`INSERT INTO artifact_revision (artifact_id, revision, content, author, created_at_ms) VALUES (?, 1, ?, 'agent', ?)`).run(artifactId, content, now);
  return taskId;
}

describe("result delivery channels", () => {
  it("stores secrets sealed for this use only and never returns them", () => {
    env = createEnv();
    const vault = ProviderKeyVault.ephemeral();
    const svc = new ChannelService(env.ledger, vault);
    const c = svc.add(env.ws.id, "owner", { kind: "telegram", label: "My phone", botToken: BOT, chatId: "4242" });
    expect(c).toMatchObject({ kind: "telegram", label: "My phone", hint: "chat …4242", agentIds: [] });
    expect(JSON.stringify(svc.list(env.ws.id))).not.toContain(BOT.split(":")[1]);
    const sealed = env.ledger.db.prepare(`SELECT secret_ciphertext FROM delivery_channel`).pluck().get() as string;
    expect(sealed).not.toContain(BOT.split(":")[1]);
    expect(() => vault.open(env.ws.id, sealed)).toThrow();
    expect(() => svc.add(env.ws.id, "owner", { kind: "telegram", label: "x", botToken: "nope", chatId: "1" })).toThrow(/bot token/);
    expect(() => svc.add(env.ws.id, "owner", { kind: "telegram", label: "x", botToken: BOT, chatId: "@channel" })).toThrow(/chat ID/);
  });

  it("accepts webhooks only on the services' own hosts", () => {
    expect(webhookProblem("slack", SLACK)).toBeNull();
    expect(webhookProblem("discord", "https://discord.com/api/webhooks/123456789012/abcdefghijklmnopqrstuvwxyz_-")).toBeNull();
    for (const bad of ["https://hooks.slack.com.evil.io/services/T/B/X", "http://hooks.slack.com/services/T000/B000/XXXX", "https://hooks.slack.com:8443/services/T000/B000/XXXX", "https://127.0.0.1/services/T/B/X", `${SLACK}?x=1`]) {
      expect(webhookProblem("slack", bad), bad).not.toBeNull();
    }
    expect(webhookProblem("discord", "https://discord.com/api/webhooks/1/x")).not.toBeNull();
  });

  it("sends a finished task's result once, as plain text, to the agent's own destination only", async () => {
    env = createEnv();
    activateDefaults(env);
    const { sent, fetchImpl } = recorder();
    const svc = new ChannelService(env.ledger, ProviderKeyVault.ephemeral(), fetchImpl, "http://localhost:4000");
    const tg = svc.add(env.ws.id, "owner", { kind: "telegram", label: "Phone", botToken: BOT, chatId: "4242" });
    const slack = svc.add(env.ws.id, "owner", { kind: "slack", label: "Team", webhookUrl: SLACK });
    svc.bind(env.ws.id, "owner", env.agents.Prince.id, tg.id as string);
    svc.bind(env.ws.id, "owner", env.agents.Mira.id, slack.id as string);

    const t1 = finishedTask(env.agents.Prince.id, "completed");
    await svc.deliverTask(t1);
    await svc.deliverTask(t1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`https://api.telegram.org/bot${BOT}/sendMessage`);
    expect(sent[0]!.body).toMatchObject({ chat_id: "4242", disable_web_page_preview: true });
    expect(sent[0]!.body.parse_mode).toBeUndefined();
    expect(String(sent[0]!.body.text)).toContain("Prince finished a job.");
    expect(String(sent[0]!.body.text)).toContain("Open in Veilo: http://localhost:4000/outputs");

    await svc.deliverTask(finishedTask(env.agents.Mira.id, "completed"));
    expect(sent[1]!.url).toBe(SLACK);
    expect(String(sent[1]!.body.text)).toContain("&lt;@here&gt; &amp;");

    // Failed tasks and agents without a destination send nothing.
    await svc.deliverTask(finishedTask(env.agents.Prince.id, "failed"));
    await svc.deliverTask(finishedTask(env.agents.Shawn.id, "completed"));
    expect(sent).toHaveLength(2);
    const audit = env.ledger.db.prepare(`SELECT COUNT(*) FROM audit_event WHERE action = 'delivery.send'`).pluck().get();
    expect(audit).toBe(2n);
  });

  it("records a refused send without throwing, and keeps another workspace's destination out of reach", async () => {
    env = createEnv();
    activateDefaults(env);
    const svc = new ChannelService(env.ledger, ProviderKeyVault.ephemeral(), async () => new Response("no", { status: 403 }));
    const tg = svc.add(env.ws.id, "owner", { kind: "telegram", label: "Phone", botToken: BOT, chatId: "4242" });
    svc.bind(env.ws.id, "owner", env.agents.Prince.id, tg.id as string);
    const t = finishedTask(env.agents.Prince.id, "completed");
    await expect(svc.deliverTask(t)).resolves.toBeUndefined();
    expect(env.ledger.db.prepare(`SELECT outcome, detail FROM task_delivery WHERE task_id = ?`).get(t)).toEqual({ outcome: "failed", detail: "the chat service refused the message (HTTP 403)" });
    expect(() => svc.bind("other-workspace", "owner", env.agents.Prince.id, tg.id as string)).toThrow(/agent not found/);
    await expect(svc.test("other-workspace", tg.id as string)).rejects.toThrow(/not found/);
  });

  it("finds the owner's Telegram chat from the bot without storing the token", async () => {
    env = createEnv();
    const { sent, fetchImpl } = recorder();
    const svc = new ChannelService(env.ledger, ProviderKeyVault.ephemeral(), fetchImpl);
    expect(await svc.telegramChats(BOT)).toEqual([{ chatId: "4242", title: "Owner" }]);
    expect(sent[0]!.url).toBe(`https://api.telegram.org/bot${BOT}/getUpdates`);
    expect(svc.list(env.ws.id)).toEqual([]);
  });
});
