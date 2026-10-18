"use client";

import { useId, useState } from "react";
import { api } from "../lib/api";
import { REVIEW_LABEL } from "../lib/labels";
import { when } from "../lib/format";
import type { CalendarEntry, ContentItem, ReviewState } from "../lib/types";
import { useCapability } from "./Shell";
import { useAction } from "./hooks";
import { Markdown, truncateMarkdown } from "./Markdown";
import { DeniedHint, ErrorNotice } from "./ui";

export const NO_CHARGE_NOTE = "Editing is free: it uses no AI, buys nothing and publishes nothing.";

const STATES: ReviewState[] = ["draft", "needs_review", "approved_for_export", "archived"];

const DETAILS = "\n— Details —\n";
/** Answers longer than this are collapsed behind "Show more". */
export const ANSWER_PREVIEW_CHARS = 1_200;
const TITLE_MAX = 80;

/** The owner-facing answer and the runner's "how it was made" lines, split at the details marker. */
export function splitOutput(content: string): { answer: string; details: string[] } {
  const i = content.indexOf(DETAILS);
  if (i < 0) return { answer: content.trim(), details: [] };
  return {
    answer: content.slice(0, i).trim(),
    details: content
      .slice(i + DETAILS.length)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== ""),
  };
}

/**
 * A short card title: the answer's first heading when it has one, otherwise the saved title
 * clipped at a word, since agent titles often repeat the owner's whole question.
 */
export function shortTitle(title: string, answer: string): string {
  const heading = answer.match(/^ {0,3}#{1,3}\s+(.+?)\s*#*\s*$/m)?.[1]?.replace(/[*_`]/g, "").trim();
  const base = (heading || title).replace(/\s+/g, " ").trim();
  if (base.length <= TITLE_MAX) return base || "Untitled output";
  const cut = base.slice(0, TITLE_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.!?-]+$/, "")}…`;
}

/** One output: the formatted answer first; editing, details and review actions on request. */
export function ContentEditor({ item, onSaved, kindLabel }: { item: ContentItem; onSaved: (next: ContentItem) => void; kindLabel?: string }) {
  const [title, setTitle] = useState(item.title);
  const [content, setContent] = useState(item.content);
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const action = useAction();
  const reviewCap = useCapability("review");
  const readOnly = !reviewCap.allowed;
  const titleId = useId();
  const bodyId = useId();
  const dirty = title !== item.title || content !== item.content;
  const archived = item.reviewState === "archived";
  const isCalendar = item.kind === "content_calendar";
  const { answer, details } = splitOutput(item.content);
  const heading = shortTitle(item.title, answer);
  const long = answer.length > ANSWER_PREVIEW_CHARS;
  const shown = long && !expanded ? truncateMarkdown(answer, ANSWER_PREVIEW_CHARS) : answer;
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
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(answer);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <article className="content-item output-card" aria-labelledby={`${titleId}-h`}>
      <header className="card-head output-card-head">
        <h3 id={`${titleId}-h`} title={item.title}>
          {heading}
        </h3>
        <span className={`pill pill-${item.reviewState === "approved_for_export" ? "ok" : item.reviewState === "archived" ? "muted" : "warn"}`}>
          {REVIEW_LABEL[item.reviewState]}
        </span>
      </header>
      <p className="small muted output-card-meta">
        {kindLabel ? <span className="pill pill-muted">{kindLabel}</span> : null}
        <span>
          {item.agent.name} · {when(item.updatedAt)}
          {item.revision > 1 ? ` · v${item.revision}` : ""}
          {item.lastAuthor === "owner" ? (readOnly ? " · edited by the owner" : " · edited by you") : ""}
        </span>
      </p>
      {!isCalendar ? (
        answer ? (
          <div className="output-answer">
            <Markdown>{shown}</Markdown>
            {long ? (
              <button type="button" className="link-btn output-more" aria-expanded={expanded} onClick={() => setExpanded((x) => !x)}>
                {expanded ? "Show less" : "Show more"}
              </button>
            ) : null}
          </div>
        ) : (
          <p className="small muted">No answer text was saved.</p>
        )
      ) : null}
      {details.length > 0 ? (
        <details className="advanced output-details">
          <summary>How it was made</summary>
          <ul className="plain small">
            {details.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {item.citations.length > 0 ? (
        <details className="advanced output-details">
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
      {!isCalendar && editing ? (
        <div className="output-editor">
          <div className="field">
            <label htmlFor={titleId}>Title</label>
            <input id={titleId} value={title} disabled={archived} readOnly={readOnly} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={bodyId}>Draft text</label>
            <textarea id={bodyId} rows={12} value={content} disabled={archived} readOnly={readOnly} onChange={(e) => setContent(e.target.value)} />
          </div>
          <div className="actions">
            <button type="button" className="btn btn-small btn-primary" disabled={!dirty || action.busy || archived || readOnly} onClick={() => void save()}>
              Save edit
            </button>
            <span className="hint actions-note">{NO_CHARGE_NOTE}</span>
          </div>
        </div>
      ) : null}
      <div className="actions output-actions" role="group" aria-label={`Actions for ${heading}`}>
        {!isCalendar ? (
          <button type="button" className="btn btn-small" aria-expanded={editing} onClick={() => setEditing((x) => !x)}>
            {editing ? "Close editor" : readOnly ? "View text" : "Edit"}
          </button>
        ) : null}
        {!isCalendar && answer ? (
          <button type="button" className="btn btn-small" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy"}
          </button>
        ) : null}
        {STATES.filter((s) => s !== item.reviewState && (!archived || s === "draft")).map((s) => (
          <button key={s} type="button" className="btn btn-small" disabled={action.busy || readOnly} onClick={() => void review(s)}>
            {s === "draft" && archived ? "Restore to draft" : `Mark ${REVIEW_LABEL[s]!.toLowerCase()}`}
          </button>
        ))}
      </div>
      {isCalendar || !editing ? <p className="hint">{NO_CHARGE_NOTE}</p> : null}
      <DeniedHint reason={reviewCap.reason} />
      <ErrorNotice error={action.error} />
    </article>
  );
}

/** Seven-day planning calendar. Dates are planning dates only; nothing is posted. */
export function ContentCalendar({ item, drafts, onSaved }: { item: ContentItem; drafts: ContentItem[]; onSaved: (next: ContentItem) => void }) {
  const [entries, setEntries] = useState<CalendarEntry[]>(item.calendar ?? []);
  const action = useAction();
  const reviewCap = useCapability("review");
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
                  readOnly={!reviewCap.allowed}
                  onChange={(ev) => setEntries(entries.map((x) => (x.day === e.day ? { ...x, action: ev.target.value } : x)))}
                />
                {draft ? <p className="small muted">Draft: {draft.title} ({REVIEW_LABEL[draft.reviewState]})</p> : null}
              </li>
            );
          })}
      </ol>
      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={!dirty || action.busy || !reviewCap.allowed || entries.some((e) => e.action.trim() === "")} onClick={() => void save()}>
          Save calendar
        </button>
      </div>
      <ErrorNotice error={action.error} />
    </div>
  );
}
