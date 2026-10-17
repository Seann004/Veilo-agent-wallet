"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { marketApi } from "../../lib/market/client";
import type { CatalogEntry } from "../../lib/market/types";
import { useResource } from "../hooks";
import { EmptyState, ErrorNotice, Loading } from "../ui";
import { useMarket } from "./MarketContext";
import { Money, TestTokenNote } from "./parts";

export function turnaround(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "—";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.round((minutes / 60) * 10) / 10} h`;
  return `${Math.round((minutes / 1440) * 10) / 10} days`;
}

/** Public catalogue of reviewed listings. No sign-in is needed to browse. */
export function Catalogue() {
  const m = useMarket();
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const searchId = useId();
  const listings = useResource(
    () => (m.configured ? marketApi<{ listings: CatalogEntry[] }>(`/marketplace/listings${q ? `?q=${encodeURIComponent(q)}` : ""}`) : Promise.resolve({ listings: [] })),
    `catalogue:${q}`,
  );
  return (
    <>
      <h1>Marketplace</h1>
      <p className="small">
        Fixed-price, fixed-scope specialists reviewed before publication. Sellers are paid directly; there is <strong>zero platform fee</strong>.
      </p>
      <TestTokenNote />
      <form
        role="search"
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(draft.trim());
        }}
      >
        <label htmlFor={searchId} className="sr-only">
          Search listings
        </label>
        <input id={searchId} type="search" maxLength={100} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Search specialists" />
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
      {listings.loading && !listings.data ? <Loading label="listings" /> : null}
      <ErrorNotice error={listings.error} what="the catalogue could not be loaded" onRetry={listings.reload} />
      {listings.data && listings.data.listings.length === 0 ? (
        <EmptyState>{q ? `No reviewed listings match “${q}”.` : "No listings have been published yet."}</EmptyState>
      ) : null}
      {listings.data && listings.data.listings.length > 0 ? (
        <ul className="cards listing-cards" aria-label={q ? `Listings matching ${q}` : "Listings"}>
          {listings.data.listings.map((l) => (
            <li key={l.listing_id} className="card listing-card">
              <h2 className="listing-title">
                <Link href={`/marketplace/${encodeURIComponent(l.slug)}`}>{l.title}</Link>
              </h2>
              <p className="role">by {l.seller_name}</p>
              <p className="small listing-summary">{l.summary}</p>
              <dl className="kv">
                <div className="kv-row">
                  <dt>Price</dt>
                  <dd>
                    <Money amount={l.price_base_units} decimals={m.decimalsFor(l.mint, l.network)} />
                  </dd>
                </div>
                <div className="kv-row">
                  <dt>Turnaround</dt>
                  <dd>{turnaround(l.turnaround_minutes)}</dd>
                </div>
                <div className="kv-row">
                  <dt>Platform fee</dt>
                  <dd>{l.fee_bps === 0 ? "Zero platform fee" : <span className="pill pill-danger">unexpected fee ({l.fee_bps} bps)</span>}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
