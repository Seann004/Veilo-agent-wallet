"use client";

import Link from "next/link";
import { useId, useRef, useState } from "react";
import { marketApi } from "../../lib/market/client";
import { toBaseUnits } from "../../lib/market/amounts";
import { SubmissionKey } from "../../lib/market/idempotency";
import type { CatalogEntry, HireResponse, ListingSample, QuoteFields } from "../../lib/market/types";
import { useAction, useResource } from "../hooks";
import { ErrorNotice, KV, Loading } from "../ui";
import { useMarket } from "./MarketContext";
import { Countdown, creatorAvatar, turnaround, DetailHeader, DetailSections, FullValue, Money, PausedNotice, PlainText, RequireMarketSession, type DetailSection } from "./parts";

const MAX_BRIEF = 16_000;

/** Problems that make a returned quote disagree with the listing the buyer is looking at. */
export function quoteProblems(q: QuoteFields, l: CatalogEntry): string[] {
  const out: string[] = [];
  if (q.listingVersionId !== l.listing_version_id) out.push("listing version changed");
  if (q.recipient !== l.recipient) out.push("recipient differs from the listing");
  if (q.mint !== l.mint || q.network !== l.network) out.push("network or mint differs from the listing");
  if (q.decimals !== l.decimals) out.push("token decimals differ from the listing");
  if (toBaseUnits(q.baseUnits) === null || q.baseUnits !== toBaseUnits(l.price_base_units)) out.push("price differs from the listing");
  if (q.feeBps !== 0 || q.feeUnits !== "0") out.push("quote carries a platform fee");
  if (q.totalUnits !== q.baseUnits) out.push("total does not equal price plus zero fee");
  return out;
}

export function ListingDetail({ slug }: { slug: string }) {
  const m = useMarket();
  const [open, setOpen] = useState("about");
  const res = useResource(
    () => (m.configured ? marketApi<{ listing: CatalogEntry; samples: ListingSample[] }>(`/marketplace/listings/${encodeURIComponent(slug)}`) : Promise.reject(new Error("marketplace not configured"))),
    `listing:${slug}`,
  );
  if (res.loading && !res.data) return <Loading label="listing" />;
  if (!res.data) return <ErrorNotice error={res.error} what="the listing could not be loaded" onRetry={res.reload} />;
  const { listing: l, samples } = res.data;
  const decimals = m.decimalsFor(l.mint, l.network);
  const sections: DetailSection[] = [
    {
      id: "about",
      label: "About",
      sub: "What you get and how fast",
      body: (
        <div className="stack">
          <PlainText text={l.description} />
          <KV
            rows={[
              ["Price", <Money key="p" amount={l.price_base_units} decimals={decimals} />],
              ["Platform fee", l.fee_bps === 0 ? "Zero platform fee" : `unexpected fee (${l.fee_bps} bps)`],
              ["Turnaround", turnaround(l.turnaround_minutes)],
              ["Output", l.output_format],
              ["Runtime", l.runtime_kind === "managed_template" ? `Managed template (${l.template ?? "—"})` : "Reviewed remote endpoint"],
            ]}
          />
        </div>
      ),
    },
    {
      id: "hire",
      label: "Hire",
      sub: "Send a brief and approve the quote",
      body: (
        <RequireMarketSession what="hire this specialist">
          <HireFlow listing={l} />
        </RequireMarketSession>
      ),
    },
    {
      id: "terms",
      label: "Payment and refunds",
      sub: "Who is paid, and refund terms",
      body: (
        <div className="stack">
          <KV
            rows={[
              ["Recipient (seller payout wallet)", <FullValue key="r" value={l.recipient} />],
              ["Network", <FullValue key="n" value={l.network} />],
              ["Mint", <FullValue key="m" value={l.mint} />],
            ]}
          />
          <h3>Refund terms</h3>
          <PlainText text={l.refund_terms} />
          <p className="small muted">Refunds are seller-funded transfers to a wallet verified on your account; Veilo cannot reverse a direct payment.</p>
          <h3>Data handling</h3>
          <PlainText text={l.data_handling} />
        </div>
      ),
    },
    {
      id: "samples",
      label: "Samples",
      sub: "Example deliverables",
      body:
        samples.length === 0 ? (
          <p className="muted">The seller has not published samples.</p>
        ) : (
          <div className="stack">
            {samples.map((s) => (
              <article key={s.id} className="content-item">
                <h3>{s.title}</h3>
                <PlainText text={s.content} className="sample" />
              </article>
            ))}
          </div>
        ),
    },
  ];
  return (
    <>
      <DetailHeader
        avatar={creatorAvatar(l.title)}
        title={l.title}
        by={l.seller_name}
        summary={l.summary}
        actions={
          <button type="button" className="btn btn-primary btn-pill" onClick={() => setOpen("hire")}>
            Hire · <Money compact amount={l.price_base_units} decimals={decimals} />
          </button>
        }
      />
      <DetailSections sections={sections} open={open} onOpen={setOpen} />
    </>
  );
}

function HireFlow({ listing }: { listing: CatalogEntry }) {
  const m = useMarket();
  const [brief, setBrief] = useState("");
  const [hire, setHire] = useState<HireResponse | null>(null);
  const [approved, setApproved] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const keys = useRef(new SubmissionKey());
  const action = useAction();
  const briefId = useId();

  if (hire) {
    const q = hire.quote;
    const verified = m.decimalsFor(q.mint, q.network);
    const problems = [...quoteProblems(q, listing), ...(verified !== null && verified !== q.decimals ? ["quote decimals differ from the mint your local controller verified"] : [])];
    return (
      <div className="quote">
        <h3>Immutable quote</h3>
        {hire.existing ? <p className="small notice">This is the job created by your earlier submission of the same brief.</p> : null}
        <KV
          rows={[
            ["Total", <Money key="t" amount={q.totalUnits} decimals={m.decimalsFor(q.mint, q.network)} />],
            ["Platform fee", <span key="f">{q.feeUnits === "0" && q.feeBps === 0 ? "0 (zero platform fee)" : `${q.feeUnits} base units (${q.feeBps} bps)`}</span>],
            ["Recipient", <FullValue key="r" value={q.recipient} />],
            ["Recipient token account", <FullValue key="a" value={q.recipientAta} />],
            ["Network / mint", <FullValue key="n" value={`${q.network} · ${q.mint}`} />],
            ["Expires", <Countdown key="e" until={q.expiresAt} onExpire={() => setExpired(true)} />],
            ["Quote digest", <FullValue key="d" value={q.quoteDigest} />],
          ]}
        />
        {problems.length > 0 ? (
          <p className="notice notice-error" role="alert">
            This quote does not match the listing ({problems.join("; ")}). Do not approve it.
          </p>
        ) : null}
        <p className="notice small" role="note">
          Approving records your intent only. Your <strong>local controller</strong> must still check this quote against your limits and authorize the
          payment; nothing is paid from here.
        </p>
        {approved ? (
          <p role="status" className="notice">
            Approved. {approved}{" "}
          </p>
        ) : (
          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!m.canAct || action.busy || problems.length > 0 || expired}
              onClick={() =>
                void action.run(async () => {
                  const r = await m.call<{ note: string }>(`/jobs/${hire.jobId}/approve`, { method: "POST", body: {} });
                  setApproved(r.note);
                })
              }
            >
              Approve quote
            </button>
          </div>
        )}
        <p>
          <Link href={`/marketplace/jobs/${hire.jobId}`}>Open the job</Link> · <Link href="/marketplace/approvals">Local approval</Link>
        </p>
        <PausedNotice />
        <ErrorNotice error={action.error} what="approval failed" />
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const text = brief.trim();
        const idempotencyKey = keys.current.keyFor(`${listing.listing_id}\n${text}`);
        void action.run(async () => {
          const r = await m.call<HireResponse>("/jobs", { method: "POST", body: { listingId: listing.listing_id, brief: text, idempotencyKey } });
          keys.current.settle();
          setHire(r);
        });
      }}
    >
      <div className="field">
        <label htmlFor={briefId}>Brief *</label>
        <textarea id={briefId} required rows={6} maxLength={MAX_BRIEF} value={brief} onChange={(e) => setBrief(e.target.value)} aria-describedby={`${briefId}-h`} />
        <span id={`${briefId}-h`} className="hint">
          {listing.input_hint ? `${listing.input_hint} · ` : ""}The seller and the marketplace operator can read your brief.
        </span>
      </div>
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={!m.canAct || action.busy || brief.trim() === ""}>
          {action.busy ? "Requesting quote…" : "Request quote"}
        </button>
      </div>
      <PausedNotice />
      <ErrorNotice error={action.error} what="the quote could not be created; retrying sends the same request" />
    </form>
  );
}
