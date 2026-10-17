"use client";

import Link from "next/link";
import { useId, useMemo, useState, type ReactNode } from "react";
import { AVATARS, ROLE_AVATAR, type AvatarOption } from "../../lib/avatar-options";
import { ROLE_LABEL } from "../../lib/labels";
import { marketApi } from "../../lib/market/client";
import type { CatalogEntry } from "../../lib/market/types";
import type { WorkflowCategory } from "@veilo/contracts/marketplace";
import { CATEGORIES, categoryLabel, type WorkflowEntry } from "../../lib/market/workflows";
import { ROLE_ORDER, ROLE_TAGLINE } from "../../lib/roles";
import type { AgentRole } from "../../lib/types";
import { useResource } from "../hooks";
import { Icon } from "../Icon";
import { useCapability } from "../Shell";
import { EmptyState, ErrorNotice, Loading } from "../ui";
import { useMarket } from "./MarketContext";
import { creatorAvatar, Money, PlainText, TestTokenNote, turnaround } from "./parts";

const TEMPLATE_CATEGORY: Partial<Record<AgentRole, WorkflowCategory>> = { research: "research", content: "content", custom: "operations" };

/** One thing on the marketplace, whatever its kind: a workflow, a specialist or a starter agent. Text is untrusted. */
interface Entry {
  key: string;
  title: string;
  by: string;
  demo?: boolean;
  summary: string;
  category: WorkflowCategory | null;
  avatar: AvatarOption;
  kind: string;
  price: ReactNode;
  href: string;
  action: string;
  runs: number;
  chain?: string[];
}

/**
 * The marketplace: every agent you can add or hire in one list. Category and search filter in
 * place, so nothing reloads or scrolls. Prices are USDC on Solana devnet.
 */
export function MarketHome({ category }: { category?: string }) {
  const m = useMarket();
  const create = useCapability("create");
  const [active, setActive] = useState<WorkflowCategory | null>(CATEGORIES.find((c) => c.id === category)?.id ?? null);
  const [query, setQuery] = useState("");
  const searchId = useId();
  const workflows = useResource(() => (m.configured ? marketApi<{ workflows: WorkflowEntry[] }>("/marketplace/workflows") : Promise.resolve({ workflows: [] })), "market:workflows");
  const listings = useResource(() => (m.configured ? marketApi<{ listings: CatalogEntry[] }>("/marketplace/listings") : Promise.resolve({ listings: [] })), "market:listings");

  const entries = useMemo<Entry[]>(() => {
    const starters: Entry[] = ROLE_ORDER.map((r) => ({
      key: `template:${r}`,
      title: ROLE_LABEL[r],
      by: "Veilo",
      summary: ROLE_TAGLINE[r],
      category: TEMPLATE_CATEGORY[r] ?? null,
      avatar: AVATARS.find((a) => a.id === ROLE_AVATAR[r]) ?? AVATARS[0]!,
      kind: "Starter agent",
      price: <span className="muted">Free · you set its budget</span>,
      href: `/agents/new?role=${r}`,
      action: "Add",
      runs: 0,
    }));
    const flows: Entry[] = (workflows.data?.workflows ?? []).map((w) => ({
      key: `workflow:${w.workflow_id}`,
      title: w.title,
      by: w.creator_name,
      demo: w.demo,
      summary: w.summary,
      category: w.category,
      avatar: creatorAvatar(w.title),
      kind: `Workflow · ${w.steps.length} step${w.steps.length === 1 ? "" : "s"}`,
      price: (
        <>
          <Money compact amount={String(w.total_base_units)} decimals={m.decimalsFor(w.mint, w.network)} /> <span className="muted">per run</span>
        </>
      ),
      href: `/marketplace/w/${encodeURIComponent(w.slug)}`,
      action: "View",
      runs: w.paid_runs,
      chain: w.steps.map((s) => s.title ?? s.kind),
    }));
    const specialists: Entry[] = (listings.data?.listings ?? []).map((l) => ({
      key: `listing:${l.listing_id}`,
      title: l.title,
      by: l.seller_name,
      summary: l.summary,
      category: null,
      avatar: creatorAvatar(l.title),
      kind: `Specialist · ${turnaround(l.turnaround_minutes)}`,
      price: (
        <>
          <Money compact amount={l.price_base_units} decimals={m.decimalsFor(l.mint, l.network)} /> <span className="muted">per job</span>
        </>
      ),
      href: `/marketplace/${encodeURIComponent(l.slug)}`,
      action: "Hire",
      runs: 0,
    }));
    return [...starters, ...flows, ...specialists];
  }, [workflows.data, listings.data, m]);

  const q = query.trim().toLowerCase();
  const shown = entries.filter((e) => (!active || e.category === active) && (!q || [e.title, e.by, e.summary].some((f) => f.toLowerCase().includes(q))));
  const featured = !active && !q ? [...entries].filter((e) => !e.key.startsWith("template:")).sort((a, b) => b.runs - a.runs).slice(0, 4) : [];
  const loading = (workflows.loading && !workflows.data) || (listings.loading && !listings.data);

  return (
    <>
      <div className="page-head">
        <h1>Marketplace</h1>
      </div>
      <p className="lede page-lede">Agents you can add to your workspace or hire for a job. Each one is a single task or a whole workflow, and every payment comes privately from your pool.</p>
      <TestTokenNote />
      <div className="market-filters">
        <label className="market-search" htmlFor={searchId}>
          <Icon name="search" size={18} />
          <span className="sr-only">Search the marketplace</span>
          <input id={searchId} type="search" maxLength={100} placeholder="Search agents, creators and workflows" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="chips" role="group" aria-label="Categories">
          <button type="button" className="chip" aria-pressed={active === null} onClick={() => setActive(null)}>
            All
          </button>
          {CATEGORIES.map((c) => (
            <button key={c.id} type="button" className="chip" aria-pressed={active === c.id} onClick={() => setActive(active === c.id ? null : c.id)}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <ErrorNotice error={workflows.error} what="workflows could not be loaded" onRetry={workflows.reload} />
      <ErrorNotice error={listings.error} what="specialists could not be loaded" onRetry={listings.reload} />

      {featured.length > 0 ? (
        <section className="market-section" aria-labelledby="m-featured">
          <h2 id="m-featured">Featured</h2>
          <ul className="featured-grid">
            {featured.map((e) => (
              <li key={e.key}>
                <Link href={e.href} className="featured">
                  <img className="featured-avatar" src={e.avatar.src} alt="" width={84} height={84} />
                  <span className="featured-text">
                    <span className="featured-name">
                      <PlainText text={e.title} inline />
                    </span>
                    <span className="featured-sub">
                      by <PlainText text={e.by} inline />
                      {e.demo ? " (demo)" : ""}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="market-section" aria-labelledby="m-all">
        <div className="market-section-head">
          <h2 id="m-all">{active ? categoryLabel(active) : q ? "Results" : "All agents"}</h2>
          <span className="muted small">New agents can't spend until you turn them on.</span>
        </div>
        {loading ? <Loading label="marketplace" /> : null}
        {!loading && shown.length === 0 ? <EmptyState>{q ? `Nothing matches “${query.trim()}”.` : "Nothing in this category yet."}</EmptyState> : null}
        <ul className="market-list" aria-label="Marketplace agents">
          {shown.map((e) => {
            const starter = e.key.startsWith("template:");
            return (
              <li key={e.key} className="market-row">
                <img className="avatar" src={e.avatar.src} alt="" width={44} height={44} />
                <span className="market-row-text">
                  <strong>
                    <Link href={e.href} className="row-link">
                      <PlainText text={e.title} inline />
                    </Link>{" "}
                    <span className="muted">
                      by <PlainText text={e.by} inline />
                      {e.demo ? " (demo)" : ""}
                    </span>
                  </strong>
                  <span>
                    <PlainText text={e.summary} inline />
                  </span>
                  <span className="market-row-meta small muted">
                    {e.kind} · {e.price}
                    {e.chain ? (
                      <span className="sr-only">
                        {" "}
                        Steps: <PlainText text={e.chain.join(", ")} inline />
                      </span>
                    ) : null}
                  </span>
                </span>
                {starter && !create.allowed ? (
                  <button type="button" className="btn btn-small btn-pill" disabled title={create.reason ?? undefined}>
                    {e.action}
                  </button>
                ) : (
                  <Link href={e.href} className="btn btn-small btn-pill" aria-label={`${e.action} ${e.title}`}>
                    {e.action}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}
