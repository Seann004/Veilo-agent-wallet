"use client";

import { useId, useState } from "react";
import { api } from "../lib/api";
import { REVIEW_LABEL } from "../lib/labels";
import type { ContentItem, Handoff, ReviewState } from "../lib/types";
import { ContentCalendar, ContentEditor } from "./Content";
import { HandoffApprovals } from "./AgentDetail";
import { useOwner } from "./Shell";
import { useResource } from "./hooks";
import { Select } from "./Select";
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
      <div className="page-head">
        <h1>Content</h1>
      </div>
      <p className="lede page-lede">What your agents wrote. Veilo never posts anything; copy approved drafts out yourself.</p>
      <div className="field-inline-select">
        <label htmlFor={filterId} className="small muted">
          Show
        </label>
        <Select
          id={filterId}
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[{ value: "" as "" | ReviewState, label: "All content" }, ...Object.entries(REVIEW_LABEL).map(([k, v]) => ({ value: k as ReviewState, label: v }))]}
        />
      </div>
      {content.loading && !content.data ? <Loading label="content" /> : null}
      <ErrorNotice error={content.error} what="content" onRetry={content.reload} />
      <Section title="Calendar">
        {calendars.length === 0 ? <p className="muted flush">No calendar yet. Send Mira a campaign brief to get one.</p> : <p className="hint">Planning dates only; nothing is scheduled to post.</p>}
        {calendars.map((c) => (
          <div key={c.id}>
            <ContentEditor item={c} onSaved={saved} />
            <ContentCalendar key={`${c.id}-${c.revision}`} item={c} drafts={drafts} onSaved={saved} />
          </div>
        ))}
      </Section>
      <Section title="Drafts">
        {drafts.length === 0 ? <p className="muted flush">No drafts yet. Send Mira a campaign brief to get some.</p> : null}
        <div className="stack">
          {drafts.map((d) => (
            <ContentEditor key={`${d.id}-${d.revision}`} item={d} onSaved={saved} />
          ))}
        </div>
      </Section>
      <Section title="Research">
        {briefs.length === 0 ? <p className="muted flush">No research yet. Ask Prince a question, or give a custom agent a job; both save their reports here.</p> : null}
        <div className="stack">
          {briefs.map((b) => (
            <ContentEditor key={`${b.id}-${b.revision}`} item={b} onSaved={saved} />
          ))}
        </div>
      </Section>
      <Section title="Research shared with Mira">
        {handoffs.data ? <HandoffApprovals handoffs={handoffs.data.items} agents={workspace.agents} onChanged={handoffs.reload} /> : <Loading label="handoffs" />}
        <ErrorNotice error={handoffs.error} onRetry={handoffs.reload} />
      </Section>
    </>
  );
}
