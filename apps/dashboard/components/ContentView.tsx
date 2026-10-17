"use client";

import { useId, useState } from "react";
import { api } from "../lib/api";
import { REVIEW_LABEL } from "../lib/labels";
import type { ContentItem, Handoff, ReviewState } from "../lib/types";
import { ContentCalendar, ContentEditor, NO_CHARGE_NOTE } from "./Content";
import { HandoffApprovals } from "./AgentDetail";
import { useOwner } from "./Shell";
import { useResource } from "./hooks";
import { ErrorNotice, Loading, Section } from "./ui";

export function ContentView() {
  const { workspace } = useOwner();
  const [filter, setFilter] = useState<"" | ReviewState>("");
  const content = useResource(() => api<{ items: ContentItem[] }>("control", `/content${filter ? `?state=${filter}` : ""}`), `content-${filter}`);
  const handoffs = useResource(() => api<{ items: Handoff[] }>("control", "/handoffs"), "handoffs");
  const [overrides, setOverrides] = useState<Record<string, ContentItem>>({});
  const filterId = useId();
  const items = (content.data?.items ?? []).map((i) => overrides[i.id] ?? i);
  const saved = (next: ContentItem) => setOverrides((o) => ({ ...o, [next.id]: next }));
  const calendars = items.filter((i) => i.kind === "content_calendar");
  const drafts = items.filter((i) => i.kind === "content_draft");
  const briefs = items.filter((i) => i.kind === "research_brief");

  return (
    <>
      <h1>Content</h1>
      <p className="notice">{NO_CHARGE_NOTE} Approved drafts are ready for manual export; Veilo has no social accounts or publishing authority.</p>
      <div className="field inline">
        <label htmlFor={filterId}>Review state</label>
        <select id={filterId} value={filter} onChange={(e) => setFilter(e.target.value as "" | ReviewState)}>
          <option value="">All</option>
          {Object.entries(REVIEW_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      {content.loading && !content.data ? <Loading label="content" /> : null}
      <ErrorNotice error={content.error} what="content" onRetry={content.reload} />
      <Section title="Seven-day calendar">
        <p className="small">Dates are planning dates, not publishing commitments.</p>
        {calendars.length === 0 ? <p className="muted">No calendars yet. Submit a campaign brief to Mira from her agent page.</p> : null}
        {calendars.map((c) => (
          <div key={c.id}>
            <ContentEditor item={c} onSaved={saved} />
            <ContentCalendar key={`${c.id}-${c.revision}`} item={c} drafts={drafts} onSaved={saved} />
          </div>
        ))}
      </Section>
      <Section title="Drafts">
        {drafts.length === 0 ? <p className="muted">No drafts yet. Submit a campaign brief to Mira from her agent page.</p> : null}
        <div className="stack">
          {drafts.map((d) => (
            <ContentEditor key={`${d.id}-${d.revision}`} item={d} onSaved={saved} />
          ))}
        </div>
      </Section>
      <Section title="Research briefs">
        {briefs.length === 0 ? <p className="muted">No research briefs yet. Ask Prince a research question from his agent page.</p> : null}
        <div className="stack">
          {briefs.map((b) => (
            <ContentEditor key={`${b.id}-${b.revision}`} item={b} onSaved={saved} />
          ))}
        </div>
      </Section>
      <Section title="Handoffs">
        {handoffs.data ? <HandoffApprovals handoffs={handoffs.data.items} agents={workspace.agents} onChanged={handoffs.reload} /> : <Loading label="handoffs" />}
        <ErrorNotice error={handoffs.error} onRetry={handoffs.reload} />
      </Section>
    </>
  );
}
