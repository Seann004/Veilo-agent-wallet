import { afterEach, describe, expect, it } from "vitest";
import { ProviderKeyVault } from "../src/ai/vault";
import { ChannelService } from "../src/channels/service";
import { saveArtifact } from "../src/ledger/summaries";
import { makeStack, type Stack } from "./fixtures/stack";

const BOT = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1";

let s: Stack | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

describe("result delivery over HTTP", () => {
  it("is owner-only, never echoes the secret, and sends once when the worker completes the job", async () => {
    const sent: Array<{ url: string; body: { text?: string } }> = [];
    s = await makeStack({
      channels: (ledger) =>
        new ChannelService(ledger, ProviderKeyVault.ephemeral(), async (url, init) => {
          sent.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as { text?: string } });
          return Response.json({ ok: true });
        }),
    });
    expect((await s.call("/channels")).status).toBe(401);
    const worker = { authorization: `Bearer ${s.worker("Mira")}` };
    expect((await s.call("/channels", { headers: worker })).status).toBe(403);

    const owner = s.ownerHeaders(await s.login());
    const added = await s.call("/channels", { method: "POST", headers: owner, body: { kind: "telegram", label: "Phone", botToken: BOT, chatId: "4242" } });
    expect(added.status).toBe(201);
    expect(JSON.stringify(added.body)).not.toContain(BOT.split(":")[1]);
    const mira = s.env.agents.Mira;
    expect((await s.call(`/agents/${mira.id}/delivery`, { method: "PUT", headers: owner, body: { channelId: added.body.channel.id } })).status).toBe(204);

    const run = await s.call(`/agents/${mira.id}/run`, {
      method: "POST",
      headers: owner,
      body: { input: { topic: "Repair cafes", audience: "Neighbours", channels: ["LinkedIn", "Newsletter", "Instagram"], voice: "Warm", startDate: "2026-10-20" } },
    });
    expect(run.status, JSON.stringify(run.body)).toBe(202);
    const claim = await s.call("/worker/jobs/claim", { method: "POST", headers: worker, body: { workerId: "runner-a", leaseMs: 60_000 } });
    saveArtifact(s.env.ledger, mira, { taskId: run.body.taskId, kind: "content_draft", title: "LinkedIn post", content: "Fix it together.", citations: [], sourcePurchaseIds: [] });
    const done = await s.call(`/worker/jobs/${claim.body.job.id}/complete`, { method: "POST", headers: worker, body: { workerId: "runner-a", version: claim.body.job.version, outcome: "completed", result: {} } });
    expect(done.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.text).toContain("LinkedIn post\n\nFix it together.");
    expect(s.count("SELECT outcome = 'sent' FROM task_delivery WHERE task_id = ?", run.body.taskId)).toBe(1);
  });
});
