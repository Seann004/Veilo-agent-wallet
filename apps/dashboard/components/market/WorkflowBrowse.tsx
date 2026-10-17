"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { marketApi } from "../../lib/market/client";
import { CATEGORIES, categoryLabel, kindGlyph, type WorkflowEntry } from "../../lib/market/workflows";
import { useResource } from "../hooks";
import { EmptyState, ErrorNotice, Loading } from "../ui";
import { useMarket } from "./MarketContext";
import { AVATARS } from "../../lib/avatar-options";
import { AvatarImage } from "../Avatar";
import { Money, PlainText, TestTokenNote } from "./parts";

const SECTION_SIZE = 4;

function WorkflowCard({ w }: { w: WorkflowEntry }) {
  const m = useMarket();
  return (
    <li className="workflow-card">
      <h3 className="listing-title">
        <Link href={`/marketplace/w/${encodeURIComponent(w.slug)}`}>
          <PlainText text={w.title} inline />
        </Link>
      </h3>
      <p className="role">
        by <PlainText text={w.creator_name} inline />
        {w.demo ? <span className="pill pill-muted"> demo</span> : null}
      </p>
      <p className="small listing-summary">
        <PlainText text={w.summary} inline />
      </p>
      {w.safety_promise ? (
        <p className="small safety-promise">
          <PlainText text={w.safety_promise} inline />
        </p>
      ) : null}
      <ol className="chain-icons" aria-label="Tool chain">
        {w.steps.map((s) => (
          <li key={s.index} title={s.title ?? s.kind}>
            <span className="chain-glyph" aria-hidden="true">
              {kindGlyph(s.kind, s.provider)}
            </span>
            <span className="sr-only">
              Step {s.index + 1}: <PlainText text={s.title ?? s.kind} inline />
            </span>
          </li>
        ))}
      </ol>
      <p className="workflow-price">
        <Money compact amount={String(w.total_base_units)} decimals={m.decimalsFor(w.mint, w.network)} /> <span className="muted">per run</span>
      </p>
    </li>
  );
}

/** A stable avatar picture per creator name. */
function creatorAvatar(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATARS[h % AVATARS.length]!;
}

/** Creators shown above the sections, ranked by paid runs then by how many live workflows they have. */
function featuredCreators(list: WorkflowEntry[]): Array<{ name: string; demo: boolean; runs: number; count: number }> {
  const by = new Map<string, { name: string; demo: boolean; runs: number; count: number }>();
  for (const w of list) {
    const c = by.get(w.creator_name) ?? { name: w.creator_name, demo: w.demo, runs: 0, count: 0 };
    c.runs += w.paid_runs;
    c.count += 1;
    by.set(w.creator_name, c);
  }
  return [...by.values()].sort((a, b) => b.runs - a.runs || b.count - a.count).slice(0, 6);
}

/**
 * Public workflow marketplace. Category tabs are links, so each category has its own URL; the
 * search filters by name, creator and description. Prices are in devnet USDC.
 */
export function WorkflowBrowse({ category }: { category?: string }) {
  const m = useMarket();
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const searchId = useId();
  const active = CATEGORIES.find((c) => c.id === category)?.id;
  const data = useResource(
    () =>
      m.configured
        ? marketApi<{ workflows: WorkflowEntry[] }>(`/marketplace/workflows?${new URLSearchParams({ ...(q ? { q } : {}), ...(active ? { category: active } : {}) }).toString()}`)
        : Promise.resolve({ workflows: [] }),
    `workflows:${active ?? "all"}:${q}`,
  );
  const list = useMemo(() => data.data?.workflows ?? [], [data.data]);
  const creators = useMemo(() => featuredCreators(list), [list]);
  const sections = active ? [{ id: active, items: list }] : CATEGORIES.map((c) => ({ id: c.id, items: list.filter((w) => w.category === c.id) })).filter((s) => s.items.length > 0);

  return (
    <>
      <div className="page-head">
        <h1>Marketplace</h1>
      </div>
      <p className="hint flush">Workflow agents chain paid tools. You approve one total budget, and each step is paid privately from your pool. No platform fee.</p>
      <TestTokenNote />
      <nav aria-label="Categories" className="category-tabs">
        <ul>
          <li>
            <Link href="/marketplace" aria-current={active ? undefined : "page"} className={active ? "tab" : "tab tab-active"}>
              All
            </Link>
          </li>
          {CATEGORIES.map((c) => (
            <li key={c.id}>
              <Link href={`/marketplace/c/${c.id}`} aria-current={active === c.id ? "page" : undefined} className={active === c.id ? "tab tab-active" : "tab"}>
                {c.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <form
        role="search"
        className="market-search-form"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(draft.trim());
        }}
      >
        <label htmlFor={searchId} className="sr-only">
          Search workflows
        </label>
        <input id={searchId} type="search" maxLength={100} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Search by creator or workflow name" />
        <button type="submit" className="btn btn-primary">
          Search
        </button>
        {q ? (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setDraft("");
              setQ("");
            }}
          >
            Clear
          </button>
        ) : null}
      </form>
      {data.loading && !data.data ? <Loading label="workflows" /> : null}
      <ErrorNotice error={data.error} what="the workflow catalogue could not be loaded" onRetry={data.reload} />
      {!active && !q && creators.length > 0 ? (
        <section aria-labelledby="featured-creators">
          <h2 id="featured-creators">Featured creators</h2>
          <ul className="creator-row">
            {creators.map((c) => (
              <li key={c.name} className="creator">
                <AvatarImage avatar={creatorAvatar(c.name)} size={44} />
                <span>
                  <PlainText text={c.name} inline />
                  {c.demo ? <span className="pill pill-muted"> demo</span> : null}
                </span>
                <span className="small muted">
                  {c.count} workflow{c.count === 1 ? "" : "s"} · {c.runs} paid run{c.runs === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {data.data && list.length === 0 ? <EmptyState>{q ? `No live workflows match “${q}”.` : "No workflows are live in this category yet."}</EmptyState> : null}
      {sections.map((s) => {
        const show = active || q ? s.items : s.items.slice(0, SECTION_SIZE);
        return (
          <section key={s.id} aria-labelledby={`sec-${s.id}`} className="workflow-section">
            <div className="section-head">
              <h2 id={`sec-${s.id}`}>{categoryLabel(s.id)}</h2>
              {!active && !q && s.items.length > SECTION_SIZE ? <Link href={`/marketplace/c/${s.id}`}>View all</Link> : null}
            </div>
            <ul className="cards workflow-cards">
              {show.map((w) => (
                <WorkflowCard key={w.workflow_id} w={w} />
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}
