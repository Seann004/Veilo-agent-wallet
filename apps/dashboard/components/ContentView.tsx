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
import { EmptyState, ErrorNotice, Loading, Section } from "./ui";

const KIND_LABEL: Record<ContentItem["kind"], string> = {
  research_brief: "Report",
  content_draft: "Draft",
  content_calendar: "Plan",
};

/** Everything any agent produced, newest first, whatever the agent was made for. */
export function ContentView() {
  const { workspace } = useOwner();
  const [filter, setFilter] = useState<"" | ReviewState>("");
  const [agentId, setAgentId] = useState("");
  const content = useResource(() => api<{ items: ContentItem[] }>("control", `/content${filter ? `?state=${filter}` : ""}`), `content-${filter}`);
  const handoffs = useResource(() => api<{ items: Handoff[] }>("control", "/handoffs"), "handoffs");
  const [overrides, setOverrides] = useState<Record<string, ContentItem>>({});
  const ids = { state: useId(), agent: useId() };
  const all = (content.data?.items ?? []).map((i) => overrides[i.id] ?? i);
  const items = all.filter((i) => !agentId || i.agent.id === agentId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const saved = (next: ContentItem) => setOverrides((o) => ({ ...o, [next.id]: next }));
  const drafts = all.filter((i) => i.kind === "content_draft");
  const producers = [...new Map(all.map((i) => [i.agent.id, i.agent.name])).entries()];
  const pendingHandoffs = handoffs.data?.items ?? [];

  return (
    <>
      <div className="page-head">
        <h1>Outputs</h1>
      </div>
      <p className="lede page-lede">Everything your agents made: reports, drafts and plans. You can edit and approve each one. Veilo never posts or sends anything on its own.</p>
      <div className="toolbar">
        <div className="field-inline-select">
          <label htmlFor={ids.agent} className="small muted">
            Agent
          </label>
          <Select id={ids.agent} label="Agent" value={agentId} onChange={setAgentId} options={[{ value: "", label: "All agents" }, ...producers.map(([id, name]) => ({ value: id, label: name }))]} />
        </div>
        <div className="field-inline-select">
          <label htmlFor={ids.state} className="small muted">
            Status
          </label>
          <Select
            id={ids.state}
            label="Status"
            value={filter}
            onChange={setFilter}
            options={[{ value: "" as "" | ReviewState, label: "Any status" }, ...Object.entries(REVIEW_LABEL).map(([k, v]) => ({ value: k as ReviewState, label: v }))]}
          />
        </div>
      </div>
      {content.loading && !content.data ? <Loading label="outputs" /> : null}
      <ErrorNotice error={content.error} what="outputs" onRetry={content.reload} />
      {content.data && items.length === 0 ? <EmptyState>Nothing yet. Give any agent a job from its page and its result lands here.</EmptyState> : null}
      <ul className="output-list">
        {items.map((i) => (
          <li key={`${i.id}-${i.revision}`} className="output-item">
            <p className="output-meta small muted">
              <span className="pill pill-muted">{KIND_LABEL[i.kind]}</span> {i.agent.name}
            </p>
            <ContentEditor item={i} onSaved={saved} />
            {i.kind === "content_calendar" ? <ContentCalendar key={`${i.id}-${i.revision}`} item={i} drafts={drafts} onSaved={saved} /> : null}
          </li>
        ))}
      </ul>
      {pendingHandoffs.length > 0 ? (
        <Section title="Shared between agents">
          <HandoffApprovals handoffs={pendingHandoffs} agents={workspace.agents} onChanged={handoffs.reload} />
        </Section>
      ) : null}
      <ErrorNotice error={handoffs.error} onRetry={handoffs.reload} />
    </>
  );
}
