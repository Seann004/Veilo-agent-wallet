"use client";

import { useId, useState } from "react";
import { api } from "../lib/api";
import { REVIEW_LABEL } from "../lib/labels";
import { when } from "../lib/format";
import type { CalendarEntry, ContentItem, ReviewState } from "../lib/types";
import { useAction } from "./hooks";
import { ErrorNotice } from "./ui";

export const NO_CHARGE_NOTE = "Editing is free: it uses no AI, buys nothing and publishes nothing.";

const STATES: ReviewState[] = ["draft", "needs_review", "approved_for_export", "archived"];

/** Owner edit/review of one artifact. Only PATCH /content/:id and POST /content/:id/review are called. */
export function ContentEditor({ item, onSaved }: { item: ContentItem; onSaved: (next: ContentItem) => void }) {
  const [title, setTitle] = useState(item.title);
  const [content, setContent] = useState(item.content);
  const action = useAction();
  const titleId = useId();
  const bodyId = useId();
  const dirty = title !== item.title || content !== item.content;
  const archived = item.reviewState === "archived";
  const save = () =>
    action.run(async () => {
      const patch: Record<string, string> = {};
      if (title !== item.title) patch.title = title;
      if (content !== item.content) patch.content = content;
      const r = await api<{ item: ContentItem }>("control", `/content/${item.id}`, { method: "PATCH", body: patch });
      onSaved(r.item);
    });
  const review = (state: ReviewState) =>
    action.run(async () => {
      const r = await api<{ item: ContentItem }>("control", `/content/${item.id}/review`, { method: "POST", body: { state } });
      onSaved(r.item);
    });
  return (
    <article className="content-item" aria-labelledby={`${titleId}-h`}>
      <header className="card-head">
        <h3 id={`${titleId}-h`}>{item.title}</h3>
        <span className={`pill pill-${item.reviewState === "approved_for_export" ? "ok" : item.reviewState === "archived" ? "muted" : "warn"}`}>
          {REVIEW_LABEL[item.reviewState]}
        </span>
      </header>
      <p className="small muted">
        By {item.agent.name} · v{item.revision}
        {item.lastAuthor === "owner" ? " · edited by you" : ""} · {when(item.updatedAt)}
      </p>
      {item.kind !== "content_calendar" ? (
        <>
          <div className="field">
            <label htmlFor={titleId}>Title</label>
            <input id={titleId} value={title} disabled={archived} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={bodyId}>Draft text</label>
            <textarea id={bodyId} rows={8} value={content} disabled={archived} onChange={(e) => setContent(e.target.value)} />
          </div>
        </>
      ) : null}
      {item.citations.length > 0 ? (
        <details>
          <summary>Citations ({item.citations.length})</summary>
          <ul className="plain small">
            {item.citations.map((c) => (
              <li key={c.url}>
                <a href={c.url} target="_blank" rel="noreferrer noopener">
                  {c.title ?? c.url}
                </a>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className="actions" role="group" aria-label={`Review state for ${item.title}`}>
        {item.kind !== "content_calendar" ? (
          <button type="button" className="btn btn-small btn-primary" disabled={!dirty || action.busy || archived} onClick={() => void save()}>
            Save edit
          </button>
        ) : null}
        <span className="hint actions-note">{NO_CHARGE_NOTE}</span>
        {STATES.filter((s) => s !== item.reviewState && (!archived || s === "draft")).map((s) => (
          <button key={s} type="button" className="btn btn-small" disabled={action.busy} onClick={() => void review(s)}>
            {s === "draft" && archived ? "Restore to draft" : `Mark ${REVIEW_LABEL[s]!.toLowerCase()}`}
          </button>
        ))}
      </div>
      <ErrorNotice error={action.error} />
    </article>
  );
}

/** Seven-day planning calendar. Dates are planning dates only; nothing is posted. */
export function ContentCalendar({ item, drafts, onSaved }: { item: ContentItem; drafts: ContentItem[]; onSaved: (next: ContentItem) => void }) {
  const [entries, setEntries] = useState<CalendarEntry[]>(item.calendar ?? []);
  const action = useAction();
  if (!item.calendar) return <p className="notice notice-warn">This calendar&apos;s saved content is not a valid seven-day plan.</p>;
  const dirty = JSON.stringify(entries) !== JSON.stringify(item.calendar);
  const save = () =>
    action.run(async () => {
      const r = await api<{ item: ContentItem }>("control", `/content/${item.id}`, { method: "PATCH", body: { calendar: entries } });
      onSaved(r.item);
      setEntries(r.item.calendar ?? []);
    });
  return (
    <div>
      <ol className="calendar" aria-label={`${item.title}: seven-day plan`}>
        {[...entries]
          .sort((a, b) => a.day - b.day)
          .map((e) => {
            const draft = drafts.find((d) => d.id === e.draftArtifactId);
            return (
              <li key={e.day} className="calendar-day">
                <h4>
                  Day {e.day}
                  {e.date ? <span className="muted small"> · {e.date}</span> : null}
                </h4>
                <p className="small">
                  <strong>{e.channel}</strong>
                </p>
                <label className="sr-only" htmlFor={`${item.id}-d${e.day}`}>
                  Day {e.day} planned action
                </label>
                <textarea
                  id={`${item.id}-d${e.day}`}
                  rows={3}
                  value={e.action}
                  disabled={item.reviewState === "archived"}
                  onChange={(ev) => setEntries(entries.map((x) => (x.day === e.day ? { ...x, action: ev.target.value } : x)))}
                />
                {draft ? <p className="small muted">Draft: {draft.title} ({REVIEW_LABEL[draft.reviewState]})</p> : null}
              </li>
            );
          })}
      </ol>
      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={!dirty || action.busy || entries.some((e) => e.action.trim() === "")} onClick={() => void save()}>
          Save calendar
        </button>
      </div>
      <ErrorNotice error={action.error} />
    </div>
  );
}
