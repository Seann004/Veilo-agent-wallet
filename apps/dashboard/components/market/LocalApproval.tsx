"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { api } from "../../lib/api";
import { when } from "../../lib/format";
import { formatUnits, parseUnits } from "../../lib/market/amounts";
import { marketApi } from "../../lib/market/client";
import { DECIMALS_UNVERIFIED } from "../../lib/market/messages";
import type { CatalogEntry } from "../../lib/market/types";
import type { Workspace } from "../../lib/types";
import { useAction, useResource } from "../hooks";
import { ConfirmButton, EmptyState, ErrorNotice, KV, Loading, Section, TxLink } from "../ui";
import { useMarket } from "./MarketContext";
import { Countdown, FullValue, Money, PlainText, TestTokenNote } from "./parts";

/** A hire as the local control service stores it; listing text and the brief are untrusted. */
export interface LocalHire {
  operationId: string;
  jobId: string;
  state: "received" | "awaiting_approval" | "authorized" | "purchasing" | "uncertain" | "paid" | "failed_unpaid" | "rejected" | string;
  listing: { listingId?: string; slug?: string; title?: string; sellerName?: string; untrusted: true };
  requestedBy: { kind: "owner" | "agent"; claimedAgentId: string | null };
  quote: {
    quoteDigest: string;
    listingVersionId: string;
    recipient: string;
    recipientAta: string;
    sellerOrigin: string;
    sellerIdentity: string;
    network: string;
    mint: string;
    baseUnits: string;
    feeUnits: string;
    totalUnits: string;
    expiresAt: string;
    label: string;
  };
  brief: string;
  /** Why a paid or funded hire needs the owner's attention; null when nothing is wrong. */
  problem?: { code: string; reason: string | null; attempts?: number; nextRetryAt?: string | null } | null;
  basis: "owner_approval" | "listing_grant" | null;
  agentId: string | null;
  approval: { agentId: string; approvedBy: string; approvedAt: string } | null;
  purchaseId: string | null;
  rejected: { code: string; reason: string | null } | null;
  evidenceSignature: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListingGrant {
  id: string;
  agentId: string;
  listingId: string;
  recipient: string;
  maxTotalUnits: string;
  createdAt: string;
}

const STATE_LABEL: Record<string, string> = {
  received: "Received — checking",
  awaiting_approval: "Waiting for your local approval",
  authorized: "Authorized — payment starting",
  purchasing: "Paying",
  uncertain: "Payment outcome uncertain — reconciling",
  paid: "Paid",
  failed_unpaid: "Failed — nothing was paid",
  rejected: "Rejected — nothing was paid",
  evidence_rejected: "Paid — evidence refused, retrying",
  recoverable: "Unpaid — funds recoverable",
};

/**
 * Local spending decisions for marketplace hires. These calls go to the owner's local control
 * service through the same-origin owner session; marketplace sign-in plays no part in them.
 */
export function LocalApproval() {
  const ws = useResource(() => api<Workspace>("control", "/workspace"), "local-approval-workspace");
  return (
    <>
      <h1>Local approval</h1>
      <p className="notice" role="note">
        This is where payments are actually authorized. Approving here lets your <strong>local controller</strong> pay the seller from the chosen
        agent&apos;s budget, after re-checking the quote and your limits. It uses your local owner sign-in, not your marketplace sign-in.
      </p>
      <TestTokenNote />
      {ws.loading && !ws.data ? <Loading label="local workspace" /> : null}
      {ws.error?.status === 401 ? (
        <p className="notice notice-warn" role="status">
          Sign in to your local owner workspace first (<Link href="/">Overview</Link>). Local approvals need the owner session that holds spending
          authority.
        </p>
      ) : (
        <ErrorNotice error={ws.error} what="the local workspace could not be loaded" onRetry={ws.reload} />
      )}
      {ws.data ? (
        <>
          <Hires workspace={ws.data} />
          <Grants workspace={ws.data} />
        </>
      ) : null}
    </>
  );
}

function Hires({ workspace }: { workspace: Workspace }) {
  const [all, setAll] = useState(false);
  const hires = useResource(() => api<{ items: LocalHire[] }>("control", `/marketplace/hires${all ? "?state=all" : ""}`), `hires:${all}`);
  return (
    <Section
      title={all ? "All marketplace hires" : "Hires waiting for local approval"}
      actions={
        <button type="button" className="btn btn-small" aria-pressed={all} onClick={() => setAll(!all)}>
          {all ? "Show pending only" : "Show all"}
        </button>
      }
    >
      {hires.loading && !hires.data ? <Loading label="hires" /> : null}
      <ErrorNotice error={hires.error} what="hires could not be loaded" onRetry={hires.reload} />
      {hires.data && hires.data.items.length === 0 ? <EmptyState>{all ? "No marketplace hires yet." : "Nothing is waiting for your approval."}</EmptyState> : null}
      {hires.data?.items.map((h) => <HireCard key={h.operationId} hire={h} workspace={workspace} onChanged={hires.reload} />)}
    </Section>
  );
}

function HireCard({ hire: h, workspace, onChanged }: { hire: LocalHire; workspace: Workspace; onChanged: () => Promise<void> }) {
  const m = useMarket();
  const action = useAction();
  const agents = workspace.agents.filter((a) => a.status === "active");
  const [agentId, setAgentId] = useState(h.requestedBy.claimedAgentId && agents.some((a) => a.id === h.requestedBy.claimedAgentId) ? h.requestedBy.claimedAgentId : (agents[0]?.id ?? ""));
  const [reason, setReason] = useState("");
  const ids = { agent: useId(), reason: useId() };
  const q = h.quote;
  const decimals = m.decimalsFor(q.mint, q.network);
  const pending = h.state === "awaiting_approval";
  const requester = h.requestedBy.kind === "agent" ? `agent ${workspace.agents.find((a) => a.id === h.requestedBy.claimedAgentId)?.name ?? h.requestedBy.claimedAgentId ?? "unknown"}` : "you (owner)";
  return (
    <article className="content-item">
      <div className="card-head">
        <h3>
          <PlainText text={h.listing.title ?? h.listing.slug ?? "Listing"} inline />
        </h3>
        <span
          className={
            h.state === "paid"
              ? "pill pill-ok"
              : ["rejected", "failed_unpaid", "evidence_rejected", "recoverable"].includes(h.state)
                ? "pill pill-danger"
                : "pill pill-warn"
          }
        >
          {STATE_LABEL[h.state] ?? h.state}
        </span>
      </div>
      <p className="small muted">
        Seller: <PlainText text={h.listing.sellerName ?? "unknown"} inline /> · requested by {requester} · {when(h.createdAt)} ·{" "}
        <Link href={`/marketplace/jobs/${h.jobId}`}>marketplace job</Link>
      </p>
      {h.problem ? (
        <div role="alert" className="notice notice-error">
          <p>
            <strong>{h.state === "evidence_rejected" ? "Paid, but the marketplace refused the payment evidence." : h.state === "recoverable" ? "Funded one-time wallet needs recovery; nothing was paid to the seller." : "Needs attention."}</strong>{" "}
            Code <code>{h.problem.code}</code>
            {h.problem.reason ? (
              <>
                : <PlainText text={h.problem.reason} inline />
              </>
            ) : null}
          </p>
          {h.problem.attempts !== undefined ? (
            <p className="small">
              Report attempts: {h.problem.attempts}
              {h.problem.nextRetryAt ? ` · next retry ${when(h.problem.nextRetryAt)}` : ""}. The payment is never shown as unpaid while this is unresolved.
            </p>
          ) : null}
          {h.state === "recoverable" ? <p className="small">Recover the funds from the Recovery page; this uses a public owner exit with its privacy warning.</p> : null}
        </div>
      ) : null}
      <h4>Brief</h4>
      <PlainText text={h.brief} className="brief" />
      <h4>Quote being approved (verbatim)</h4>
      <KV
        rows={[
          ["totalUnits", <span key="t">
            <Money amount={q.totalUnits} decimals={decimals} />
          </span>],
          ["baseUnits", <FullValue key="b" value={q.baseUnits} />],
          ["feeUnits", <FullValue key="f" value={q.feeUnits} />],
          ["recipient", <FullValue key="r" value={q.recipient} />],
          ["recipientAta", <FullValue key="ra" value={q.recipientAta} />],
          ["network", <FullValue key="n" value={q.network} />],
          ["mint", <FullValue key="m" value={q.mint} />],
          ["sellerOrigin", <FullValue key="so" value={q.sellerOrigin} />],
          ["sellerIdentity", <FullValue key="si" value={q.sellerIdentity} />],
          ["listingVersionId", <FullValue key="lv" value={q.listingVersionId} />],
          ["quoteDigest", <FullValue key="d" value={q.quoteDigest} />],
          ["expiresAt", pending ? <span key="e"><FullValue value={q.expiresAt} /> <Countdown until={q.expiresAt} /></span> : <FullValue key="e" value={q.expiresAt} />],
          ["operationId", <FullValue key="o" value={h.operationId} />],
        ]}
      />
      {h.approval ? (
        <p className="small">
          Approved {when(h.approval.approvedAt)} for agent {workspace.agents.find((a) => a.id === h.approval!.agentId)?.name ?? h.approval.agentId}.
        </p>
      ) : h.basis === "listing_grant" ? (
        <p className="small">Authorized automatically by a local listing grant.</p>
      ) : null}
      {h.rejected ? (
        <p className="small notice notice-warn">
          Rejected: {h.rejected.code}
          {h.rejected.reason ? <PlainText text={h.rejected.reason} inline /> : null}
        </p>
      ) : null}
      {h.evidenceSignature ? (
        <p className="small">
          Settlement: <TxLink signature={h.evidenceSignature} />
        </p>
      ) : null}
      {pending ? (
        <div className="local-approval">
          <div className="field">
            <label htmlFor={ids.agent}>Pay from agent budget *</label>
            {agents.length === 0 ? (
              <p className="small notice notice-warn">No active local agent. Activate an agent in your workspace first.</p>
            ) : (
              <select id={ids.agent} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.role})
                  </option>
                ))}
              </select>
            )}
            <span className="hint">The controller still enforces this agent&apos;s limits and the workspace limits; an over-budget approval is refused.</span>
          </div>
          <div className="actions">
            <ConfirmButton
              label="Approve payment"
              confirmLabel="Confirm local payment approval"
              disabled={action.busy || agentId === ""}
              warning={`Authorize paying ${q.totalUnits} base units to ${q.recipient} for quote ${q.quoteDigest.slice(0, 12)}…?`}
              onConfirm={() =>
                void action.run(async () => {
                  await api("control", `/marketplace/hires/${encodeURIComponent(h.operationId)}/approve`, {
                    method: "POST",
                    body: { quoteDigest: q.quoteDigest, recipient: q.recipient, totalUnits: q.totalUnits, agentId },
                  });
                  await onChanged();
                })
              }
            />
          </div>
          <div className="field">
            <label htmlFor={ids.reason}>Rejection reason (optional)</label>
            <input id={ids.reason} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="actions">
            <ConfirmButton
              label="Reject"
              confirmLabel="Confirm reject"
              danger
              disabled={action.busy}
              warning="Rejecting cancels this hire; nothing is paid."
              onConfirm={() =>
                void action.run(async () => {
                  await api("control", `/marketplace/hires/${encodeURIComponent(h.operationId)}/reject`, {
                    method: "POST",
                    body: reason.trim() ? { reason: reason.trim() } : {},
                  });
                  await onChanged();
                })
              }
            />
          </div>
        </div>
      ) : null}
      <ErrorNotice error={action.error} what="local decision failed" />
    </article>
  );
}

function Grants({ workspace }: { workspace: Workspace }) {
  const agents = workspace.agents.filter((a) => a.status !== "revoked" && a.status !== "archived");
  return (
    <Section title="Local listing grants">
      <p className="small">
        A grant lets one local agent hire one listing without asking you each time, up to a maximum total. Grants live in your local controller and
        replace any cloud proposal; the controller still applies every budget limit.
      </p>
      {agents.length === 0 ? <EmptyState>No local agents.</EmptyState> : agents.map((a) => <AgentGrants key={a.id} agentId={a.id} name={a.name} />)}
    </Section>
  );
}

function AgentGrants({ agentId, name }: { agentId: string; name: string }) {
  const m = useMarket();
  const action = useAction();
  const grants = useResource(() => api<{ grants: ListingGrant[] }>("control", `/agents/${agentId}/marketplace-allowlist`), `grants:${agentId}`);
  const catalogue = useResource(() => (m.configured ? marketApi<{ listings: CatalogEntry[] }>("/marketplace/listings?limit=50") : Promise.resolve({ listings: [] as CatalogEntry[] })), "grant-catalogue");
  const [listingId, setListingId] = useState("");
  const [max, setMax] = useState("");
  const ids = { listing: useId(), max: useId() };
  const current = grants.data?.grants ?? [];
  const decimals = m.token?.decimals ?? null;
  const parsed = decimals === null ? null : parseUnits(max, decimals);
  const chosen = catalogue.data?.listings.find((l) => l.listing_id === listingId);
  const save = (next: Array<{ listingId: string; recipient: string; maxTotalUnits: string }>) =>
    action.run(async () => {
      await api("control", `/agents/${agentId}/marketplace-allowlist`, { method: "PUT", body: { grants: next } });
      await grants.reload();
    });
  const asBody = (g: ListingGrant) => ({ listingId: g.listingId, recipient: g.recipient, maxTotalUnits: g.maxTotalUnits });
  const titleOf = (id: string) => catalogue.data?.listings.find((l) => l.listing_id === id)?.title ?? id;
  return (
    <article className="content-item">
      <h3>{name}</h3>
      {grants.loading && !grants.data ? <Loading label="grants" /> : null}
      <ErrorNotice error={grants.error} what="grants could not be loaded" onRetry={grants.reload} />
      {grants.data && current.length === 0 ? <p className="small muted">No listing grants: every hire for this agent needs your approval.</p> : null}
      <ul className="plain">
        {current.map((g) => (
          <li key={g.id} className="version">
            {titleOf(g.listingId)} · up to <Money amount={g.maxTotalUnits} decimals={decimals} /> · recipient{" "}
            <FullValue value={g.recipient} />{" "}
            <button type="button" className="btn btn-small" disabled={action.busy} onClick={() => void save(current.filter((x) => x.id !== g.id).map(asBody))}>
              Remove grant
            </button>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!chosen || !parsed?.ok) return;
          void save([...current.filter((g) => g.listingId !== chosen.listing_id).map(asBody), { listingId: chosen.listing_id, recipient: chosen.recipient, maxTotalUnits: parsed.value }]).then(() => {
            setListingId("");
            setMax("");
          });
        }}
      >
        <div className="grid-2">
          <div className="field">
            <label htmlFor={ids.listing}>Listing</label>
            <select id={ids.listing} value={listingId} onChange={(e) => setListingId(e.target.value)}>
              <option value="">Choose a published listing</option>
              {catalogue.data?.listings.map((l) => (
                <option key={l.listing_id} value={l.listing_id}>
                  {l.title} — {l.seller_name} ({m.decimalsFor(l.mint, l.network) === null ? `${String(l.price_base_units)} base units` : `${formatUnits(l.price_base_units, m.decimalsFor(l.mint, l.network)!)} test tokens`})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={ids.max}>Maximum total per hire</label>
            <input id={ids.max} inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} disabled={decimals === null} aria-describedby={`${ids.max}-h`} />
            <span id={`${ids.max}-h`} className={max && parsed && !parsed.ok ? "hint field-error" : "hint"}>
              {decimals === null ? `Amount entry disabled: ${DECIMALS_UNVERIFIED}.` : max && parsed && !parsed.ok ? parsed.error : "Test tokens; the recipient is pinned to the listing's payout wallet."}
            </span>
          </div>
        </div>
        <button type="submit" className="btn" disabled={action.busy || !chosen || !parsed?.ok}>
          Save grant
        </button>
      </form>
      <ErrorNotice error={action.error} what="grants not saved" />
    </article>
  );
}
