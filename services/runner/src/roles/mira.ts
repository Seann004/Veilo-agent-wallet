import { SPONSORED_PLANNING_LABEL } from "@veilo/contracts/gateway";
import type { ControlReply } from "../control-client";
import { BYOK_LABEL, buy, delivered, outcomeText, plan, runAi, step, tryTool, type CatalogItem, type RoleContext, type RoleOutcome } from "./common";

interface Draft {
  channel: string;
  title: string;
  body: string;
}

interface CalendarItem {
  day: number;
  channel: string;
  draftIndex: number | null;
  action: string;
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Mira: owner campaign brief, optionally with an owner-approved research handoff. Buys one
 * content-package directly per call through the private x402 path (never prepaid credits) and
 * saves three editable channel drafts and a seven-day planning calendar. Nothing is published.
 */
export async function runMira(ctx: RoleContext): Promise<RoleOutcome> {
  const brief = ctx.task.input as {
    topic: string;
    audience: string;
    channels: string[];
    voice: string;
    deliverables?: string;
    startDate?: string;
    handoff?: { title: string; content: string; artifactId: string };
  };
  await step(ctx, "Checking services and budget");
  const catalogReply = await tryTool(ctx, "catalog_lookup");
  await tryTool(ctx, "budget_summary");
  const catalog: CatalogItem[] = Array.isArray(catalogReply.body?.items) ? catalogReply.body.items : [];
  const item = catalog.find((c) => c.sku === "content-package" && c.paymentPath === "private_x402");

  let research = "";
  if (brief.handoff) {
    await step(ctx, "Reading the approved research");
    const planned = await plan(
      ctx,
      "condense approved research",
      "Condense the research brief into at most 12 short factual bullet points for a content writer. Keep the bracketed evidence numbers. Do not add facts.",
      brief.handoff.content.slice(0, 10_000),
    );
    research = (planned ?? brief.handoff.content.split("\n").filter((l) => l.startsWith("- ")).slice(0, 12).join("\n")).slice(0, 6_000);
  }

  const startDate = brief.startDate ?? new Date(ctx.now()).toISOString().slice(0, 10);
  const input = {
    topic: brief.topic,
    audience: brief.audience,
    channels: brief.channels,
    voice: brief.voice,
    startDate,
    ...(research ? { brief: `${brief.deliverables ?? ""}\nResearch (owner-approved handoff, demo fixture data):\n${research}`.slice(0, 16_000) } : brief.deliverables ? { brief: brief.deliverables } : {}),
  };
  // The owner's own model first; a paid content package only if no provider is set.
  await step(ctx, "Writing the content package");
  const own = await runAi(ctx, "content-package", input);
  if (!own && !item) {
    ctx.notes.push("No model provider is set and content-package via direct x402 is not in this agent's approved catalog.");
    return { taskState: "failed", summary: { notes: ctx.notes } };
  }
  const r: ControlReply = own
    ? { status: 200, body: { purchase: { states: { fulfilment: "delivered" } }, execution: { result: own.json } } }
    : await buy(ctx, item!, "content-package", input, "Direct per-call content package for the campaign brief");
  const purchaseId = own ? null : ((r.body?.purchase?.id as string | undefined) ?? null);
  const result = r.body?.execution?.result as { drafts?: Draft[]; calendar?: CalendarItem[]; provenance?: { label?: string }; issues?: string[]; raw?: string } | null;
  const footer = [
    "",
    "---",
    own
      ? `Generated on ${BYOK_LABEL.toLowerCase()} (${own.model}); no USDC spent.`
      : `Purchased: content-package via direct x402 (${item!.price.amount} USDC base units) — ${outcomeText(r)}.`,
    result?.provenance?.label ? `Generation: ${result.provenance.label}.` : "",
    `${ctx.client.planningCalls} ${SPONSORED_PLANNING_LABEL} call(s).`,
    "Draft for owner review. Nothing is published or sent automatically.",
  ].filter((l) => l !== "");

  if (!delivered(r) || !Array.isArray(result?.drafts) || !Array.isArray(result?.calendar)) {
    const issues = result?.issues ?? [];
    const saved = await tryTool(ctx, "save_artifact", {
      kind: "content_draft",
      title: `Incomplete content package: ${brief.topic}`.slice(0, 200),
      content: [
        "The paid content package did not produce valid drafts. A new attempt is a separate, budgeted task.",
        ...issues.map((i) => `- ${i}`),
        ...(typeof result?.raw === "string" ? ["", "Partial output:", result.raw.slice(0, 20_000)] : []),
        ...footer,
      ].join("\n"),
      sourcePurchaseIds: purchaseId ? [purchaseId] : [],
    });
    return { taskState: "incomplete", summary: { purchase: outcomeText(r), artifactId: saved.body?.id ?? null } };
  }

  await step(ctx, "Saving drafts and calendar");
  const draftIds: string[] = [];
  for (const d of result.drafts.slice(0, 3)) {
    const saved = await tryTool(ctx, "save_artifact", {
      kind: "content_draft",
      title: `${d.channel}: ${d.title}`.slice(0, 200),
      content: [d.body, ...footer].join("\n"),
      sourcePurchaseIds: purchaseId ? [purchaseId] : [],
    });
    if (saved.status !== 201) return { taskState: "failed", summary: { error: saved.body?.error ?? null, draftIds } };
    draftIds.push(saved.body.id as string);
  }
  const calendar = [...result.calendar]
    .sort((a, b) => a.day - b.day)
    .map((c) => ({
      day: c.day,
      date: addDays(startDate, c.day - 1),
      channel: c.channel,
      draftArtifactId: c.draftIndex === null ? null : (draftIds[c.draftIndex] ?? null),
      action: c.action,
    }));
  const cal = await tryTool(ctx, "save_artifact", {
    kind: "content_calendar",
    title: `Seven-day plan: ${brief.topic}`.slice(0, 200),
    content: JSON.stringify(calendar),
    sourcePurchaseIds: purchaseId ? [purchaseId] : [],
  });
  if (cal.status !== 201) return { taskState: "failed", summary: { error: cal.body?.error ?? null, draftIds } };
  return { taskState: "completed", summary: { purchaseId, draftIds, calendarId: cal.body.id, notes: ctx.notes } };
}
