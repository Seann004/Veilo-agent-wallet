"use client";

import Link from "next/link";
import { useEffect, useId, useState, type ReactNode } from "react";
import { shortKey, when } from "../../lib/format";
import { parseUnits } from "../../lib/market/amounts";
import { supabase } from "../../lib/market/client";
import { presentJob } from "../../lib/market/job-state";
import { DECIMALS_UNVERIFIED, NO_BALANCE_NOTE, OFFER_DRAFT_KEY, payoutProofMessage } from "../../lib/market/messages";
import { MANAGED_TEMPLATES, type RefundRow, type SellerDashboard } from "../../lib/market/types";
import { listWallets, onWalletsChanged, signChallenge, type OwnerWallet } from "../../lib/wallet";
import { useAction, useResource } from "../hooks";
import { ErrorNotice, KV, Loading, Section } from "../ui";
import { RefundItem } from "./JobDetail";
import { useMarket } from "./MarketContext";
import { Address, FullValue, JobStates, Money, PausedNotice, PlainText, RequireMarketSession } from "./parts";
import { Select } from "../Select";

export function SellerConsole() {
  return (
    <>
      <h1>Seller console</h1>
      <RequireMarketSession what="open the seller console">
        <Console />
      </RequireMarketSession>
    </>
  );
}

function Console() {
  const m = useMarket();
  const dash = useResource(() => m.call<SellerDashboard>("/seller/dashboard"), `seller:${m.me?.userId ?? ""}`);
  if (dash.loading && !dash.data) return <Loading label="seller console" />;
  if (!dash.data) return <ErrorNotice error={dash.error} what="the seller console could not be loaded" onRetry={dash.reload} />;
  const d = dash.data;
  const reload = async () => {
    await dash.reload();
    await m.reloadMe();
  };
  return (
    <>
      <PausedNotice />
      <ErrorNotice error={dash.error} what="refresh failed; showing the last loaded data" onRetry={dash.reload} />
      <Profile d={d} onChanged={reload} />
      {d.seller ? (
        <>
          <Payouts d={d} onChanged={reload} />
          <Listings d={d} onChanged={reload} />
          <Earnings d={d} />
          <AssignedJobs d={d} />
        </>
      ) : (
        <p className="notice">Create your seller profile first. An operator reviews it before your listings can be published.</p>
      )}
    </>
  );
}

function Profile({ d, onChanged }: { d: SellerDashboard; onChanged: () => Promise<void> }) {
  const m = useMarket();
  const action = useAction();
  const [name, setName] = useState(d.seller?.public_name ?? "");
  const [desc, setDesc] = useState(d.seller?.description ?? "");
  const ids = { name: useId(), desc: useId() };
  return (
    <Section title="Seller profile" actions={d.seller ? <span className={d.seller.status === "approved" ? "pill pill-ok" : "pill pill-warn"}>Review: {d.seller.status}</span> : null}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await m.call("/seller/profile", { method: "POST", body: { publicName: name.trim(), description: desc.trim() } });
            await onChanged();
          });
        }}
      >
        <div className="field">
          <label htmlFor={ids.name}>Public name *</label>
          <input id={ids.name} required minLength={2} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={ids.desc}>Description</label>
          <textarea id={ids.desc} rows={3} maxLength={2000} value={desc} onChange={(e) => setDesc(e.target.value)} />
          <span className="hint">Shown publicly once approved.</span>
        </div>
        <button type="submit" className="btn btn-primary" disabled={!m.canAct || action.busy || name.trim().length < 2}>
          {d.seller ? "Update profile" : "Create seller profile"}
        </button>
        <ErrorNotice error={action.error} what="profile not saved" />
      </form>
    </Section>
  );
}

function useWallets(): OwnerWallet[] {
  const [wallets, setWallets] = useState<OwnerWallet[]>([]);
  useEffect(() => {
    const refresh = () => setWallets(listWallets());
    refresh();
    return onWalletsChanged(refresh);
  }, []);
  return wallets;
}

function Payouts({ d, onChanged }: { d: SellerDashboard; onChanged: () => Promise<void> }) {
  const m = useMarket();
  const action = useAction();
  const wallets = useWallets();
  const [issuedAt, setIssuedAt] = useState<string | null>(null);
  const address = m.wallet?.account.address ?? null;
  const message =
    m.me && address && m.token && issuedAt ? payoutProofMessage({ userId: m.me.userId, address, network: m.token.network, mint: m.token.mint, issuedAt }) : null;
  const notReady = action.error?.code === "NOT_READY";
  return (
    <Section title="Payout wallet">
      <p className="small">
        Buyers pay this wallet directly. Prove you control it by signing a message; no transaction is sent. The wallet also needs a token account for
        the marketplace mint.
      </p>
      {d.payouts.length === 0 ? (
        <p className="muted">No verified payout wallet yet.</p>
      ) : (
        <ul className="plain">
          {d.payouts.map((p) => (
            <li key={p.id}>
              <FullValue value={p.address} /> <span className="small muted">token account {shortKey(p.ata, 6)} · verified {when(p.verified_at)}</span>
            </li>
          ))}
        </ul>
      )}
      <ErrorNotice error={m.tokenError} what="marketplace network and mint unavailable" />
      {!m.wallet ? (
        <div className="actions">
          {wallets.length === 0 ? <p className="small muted">No compatible wallet detected.</p> : null}
          {wallets.map((w) => (
            <button key={w.name} type="button" className="btn" disabled={action.busy} onClick={() => void action.run(() => m.connectWallet(w))}>
              <img src={w.icon} alt="" width={20} height={20} /> Connect {w.name}
            </button>
          ))}
        </div>
      ) : (
        <>
          <p className="small">
            Payout wallet to prove: <Address value={address} /> (the wallet you signed in with).
          </p>
          {message ? (
            <>
              <p className="small">Your wallet will be asked to sign exactly:</p>
              <pre className="message">{message}</pre>
            </>
          ) : null}
          <div className="actions">
            {!issuedAt ? (
              <button type="button" className="btn" disabled={!m.canAct || !m.token} onClick={() => setIssuedAt(new Date().toISOString())}>
                Prepare payout proof
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!m.canAct || action.busy || !message}
                onClick={() =>
                  void action.run(async () => {
                    if (!m.wallet || !message || !address) return;
                    const signature = await signChallenge(m.wallet.wallet, m.wallet.account, message);
                    await m.call("/seller/payouts", { method: "POST", body: { address, issuedAt, signature } });
                    setIssuedAt(null);
                    await onChanged();
                  })
                }
              >
                Sign and verify payout wallet
              </button>
            )}
          </div>
        </>
      )}
      {notReady ? (
        <p className="notice notice-warn" role="status">
          The payout wallet has no token account for mint {m.token?.mint ?? "(unknown)"} yet. Create the associated token account for this mint (for
          example by receiving a small amount of USDC), then prepare a fresh proof and try again.
        </p>
      ) : null}
      <ErrorNotice error={action.error} what="payout wallet not verified" />
    </Section>
  );
}

function Listings({ d, onChanged }: { d: SellerDashboard; onChanged: () => Promise<void> }) {
  const m = useMarket();
  const action = useAction();
  const [slug, setSlug] = useState("");
  const [versionFor, setVersionFor] = useState<string | null>(null);
  const slugId = useId();
  const slugOk = /^[a-z0-9][a-z0-9-]{2,62}$/.test(slug);
  return (
    <Section title="Listings">
      {d.listings.length === 0 ? <p className="muted">No listings yet.</p> : null}
      {d.listings.map((l) => {
        const versions = d.versions.filter((v) => v.listing_id === l.id);
        return (
          <article key={l.id} className="content-item">
            <div className="card-head">
              <h3>{l.slug}</h3>
              <span className={l.status === "published" ? "pill pill-ok" : "pill"}>{l.status}</span>
            </div>
            {l.status === "published" ? (
              <p className="small">
                <Link href={`/marketplace/${encodeURIComponent(l.slug)}`}>View public listing</Link>
              </p>
            ) : null}
            {versions.length === 0 ? <p className="small muted">No versions yet.</p> : null}
            <ul className="plain">
              {versions.map((v) => (
                <li key={v.id} className="version">
                  v{v.version_no} · {v.title} · <Money amount={v.price_base_units} decimals={m.token?.decimals} /> · review{" "}
                  <span className={v.review_status === "approved" ? "pill pill-ok" : v.review_status === "rejected" ? "pill pill-danger" : "pill pill-warn"}>
                    {v.review_status}
                  </span>
                  {v.review_note ? <PlainText text={`Reviewer note: ${v.review_note}`} className="small" /> : null}
                  {v.review_status === "pending" ? (
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={!m.canAct || action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          await m.call(`/seller/versions/${v.id}/submit`, { method: "POST", body: {} });
                          await onChanged();
                        })
                      }
                    >
                      Submit v{v.version_no} for review
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            <button type="button" className="btn btn-small" aria-expanded={versionFor === l.id} onClick={() => setVersionFor(versionFor === l.id ? null : l.id)}>
              {versionFor === l.id ? "Close new version form" : "New version"}
            </button>
            {versionFor === l.id ? (
              <VersionForm
                listingId={l.id}
                d={d}
                onCreated={async () => {
                  setVersionFor(null);
                  await onChanged();
                }}
              />
            ) : null}
          </article>
        );
      })}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const r = await m.call<{ listingId: string }>("/seller/listings", { method: "POST", body: { slug } });
            setSlug("");
            setVersionFor(r.listingId);
            await onChanged();
          });
        }}
      >
        <h3>Create listing</h3>
        <div className="field">
          <label htmlFor={slugId}>Slug *</label>
          <input id={slugId} required value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} aria-describedby={`${slugId}-h`} />
          <span id={`${slugId}-h`} className="hint">
            3–63 characters: lowercase letters, digits and hyphens. Used in the public URL; cannot be changed later.
          </span>
        </div>
        <button type="submit" className="btn btn-primary" disabled={!m.canAct || action.busy || !slugOk}>
          Create listing
        </button>
      </form>
      <ErrorNotice error={action.error} what="listing action failed" />
    </Section>
  );
}

/** A custom agent's instructions handed over from its page; the form clears it once mounted. */
function offerDraft(): { title: string; sellerInstructions: string } {
  try {
    const raw = sessionStorage.getItem(OFFER_DRAFT_KEY);
    const d = raw ? (JSON.parse(raw) as { title?: unknown; sellerInstructions?: unknown }) : {};
    return {
      title: typeof d.title === "string" ? d.title.slice(0, 120) : "",
      sellerInstructions: typeof d.sellerInstructions === "string" ? d.sellerInstructions.slice(0, 8000) : "",
    };
  } catch {
    return { title: "", sellerInstructions: "" };
  }
}

function VersionForm({ listingId, d, onCreated }: { listingId: string; d: SellerDashboard; onCreated: () => Promise<void> }) {
  const m = useMarket();
  const action = useAction();
  const [f, setF] = useState(() => ({
    ...offerDraft(),
    summary: "",
    description: "",
    runtimeKind: "managed_template" as "managed_template" | "remote_endpoint",
    template: MANAGED_TEMPLATES[0] as string,
    remoteOrigin: "",
    briefHint: "",
    maxBriefChars: "16000",
    format: "markdown" as "markdown" | "json",
    sections: "",
    price: "",
    payoutVersionId: d.payouts[0]?.id ?? "",
    turnaroundMinutes: "60",
    refundTerms: "",
    dataHandling: "",
    termsVersion: "1",
  }));
  useEffect(() => {
    try {
      sessionStorage.removeItem(OFFER_DRAFT_KEY);
    } catch {
      // Nothing to clear without storage.
    }
  }, []);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const id = useId();
  const decimals = m.token?.decimals ?? null;
  const price = decimals === null ? null : parseUnits(f.price, decimals);
  const priceError = f.price === "" ? null : price === null ? DECIMALS_UNVERIFIED : price.ok ? null : price.error;
  const field = (k: keyof typeof f, label: string, input: ReactNode, hint?: string) => (
    <div className="field">
      <label htmlFor={`${id}-${k}`}>{label}</label>
      {input}
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
  return (
    <form
      className="version-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!price?.ok) return;
        void action.run(async () => {
          await m.call(`/seller/listings/${listingId}/versions`, {
            method: "POST",
            body: {
              title: f.title.trim(),
              summary: f.summary.trim(),
              description: f.description.trim(),
              runtimeKind: f.runtimeKind,
              template: f.runtimeKind === "managed_template" ? f.template : null,
              remoteOrigin: f.runtimeKind === "remote_endpoint" ? f.remoteOrigin.trim() : null,
              sellerInstructions: f.sellerInstructions,
              inputSchema: { briefHint: f.briefHint.trim(), maxBriefChars: Number(f.maxBriefChars) },
              outputSchema: {
                format: f.format,
                sections: f.sections
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean),
              },
              priceBaseUnits: price.value,
              payoutVersionId: f.payoutVersionId,
              turnaroundMinutes: Number(f.turnaroundMinutes),
              refundTerms: f.refundTerms.trim(),
              dataHandling: f.dataHandling.trim(),
              termsVersion: f.termsVersion.trim(),
            },
          });
          await onCreated();
        });
      }}
    >
      <h4>New listing version</h4>
      <p className="small muted">A version is immutable once created. Submit it for operator review to publish it.</p>
      {field("title", "Title *", <input id={`${id}-title`} required minLength={3} maxLength={120} value={f.title} onChange={set("title")} />)}
      {field("summary", "Summary *", <input id={`${id}-summary`} required minLength={10} maxLength={500} value={f.summary} onChange={set("summary")} />)}
      {field("description", "Public description *", <textarea id={`${id}-description`} required minLength={10} maxLength={8000} rows={4} value={f.description} onChange={set("description")} />)}
      <fieldset>
        <legend>Runtime</legend>
        <div className="checks">
          <label>
            <input type="radio" name={`${id}-rk`} checked={f.runtimeKind === "managed_template"} onChange={() => setF({ ...f, runtimeKind: "managed_template" })} /> Managed template
          </label>
          <label>
            <input type="radio" name={`${id}-rk`} checked={f.runtimeKind === "remote_endpoint"} onChange={() => setF({ ...f, runtimeKind: "remote_endpoint" })} /> Remote https origin
          </label>
        </div>
        {f.runtimeKind === "managed_template"
          ? field(
              "template",
              "Template",
              <Select id={`${id}-template`} label="Template" value={f.template} options={MANAGED_TEMPLATES.map((t) => ({ value: t, label: t }))} onChange={(v) => setF({ ...f, template: v })} />,
            )
          : field(
              "remoteOrigin",
              "Remote origin *",
              <input id={`${id}-remoteOrigin`} required type="url" placeholder="https://seller.example.com" value={f.remoteOrigin} onChange={set("remoteOrigin")} />,
              "A bare public https origin (no path). It is reviewed before publication.",
            )}
      </fieldset>
      <fieldset className="private-field">
        <legend>Private seller-only instructions</legend>
        {field(
          "sellerInstructions",
          "Instructions for your runtime (private)",
          <textarea id={`${id}-sellerInstructions`} maxLength={8000} rows={3} value={f.sellerInstructions} onChange={set("sellerInstructions")} />,
          "Never shown in the public catalogue or to buyers. Do not put secrets or credentials here.",
        )}
      </fieldset>
      <div className="grid-2">
        {field("briefHint", "Brief hint for buyers", <input id={`${id}-briefHint`} maxLength={500} value={f.briefHint} onChange={set("briefHint")} />)}
        {field("maxBriefChars", "Max brief length", <input id={`${id}-maxBriefChars`} inputMode="numeric" value={f.maxBriefChars} onChange={set("maxBriefChars")} />, "100–16000 characters")}
        {field(
          "format",
          "Output format",
          <Select id={`${id}-format`} label="Output format" value={f.format} options={[{ value: "markdown", label: "markdown" }, { value: "json", label: "json" }]} onChange={(v) => setF({ ...f, format: v })} />,
        )}
        {field("sections", "Output sections (one per line)", <textarea id={`${id}-sections`} rows={3} value={f.sections} onChange={set("sections")} />)}
        <div className="field">
          <label htmlFor={`${id}-price`}>Price *</label>
          <input id={`${id}-price`} required inputMode="decimal" value={f.price} onChange={set("price")} aria-invalid={priceError ? true : undefined} aria-describedby={`${id}-price-h`} disabled={decimals === null} />
          <span id={`${id}-price-h`} className={priceError ? "hint field-error" : "hint"} role={priceError ? "alert" : undefined}>
            {decimals === null
              ? `Amount entry disabled: ${DECIMALS_UNVERIFIED}.`
              : (priceError ?? `Decimal amount in USDC, at most ${decimals} decimal places. Platform fee is zero.`)}
          </span>
        </div>
        {field(
          "payoutVersionId",
          "Payout wallet *",
          d.payouts.length === 0 ? (
            <p id={`${id}-payoutVersionId`} className="small notice notice-warn">
              Verify a payout wallet first.
            </p>
          ) : (
            <Select id={`${id}-payoutVersionId`} label="Payout wallet" value={f.payoutVersionId} options={d.payouts.map((p) => ({ value: p.id, label: p.address }))} onChange={(v) => setF({ ...f, payoutVersionId: v })} />
          ),
        )}
        {field("turnaroundMinutes", "Turnaround (minutes) *", <input id={`${id}-turnaroundMinutes`} required inputMode="numeric" value={f.turnaroundMinutes} onChange={set("turnaroundMinutes")} />)}
        {field("termsVersion", "Terms version *", <input id={`${id}-termsVersion`} required maxLength={40} value={f.termsVersion} onChange={set("termsVersion")} />)}
      </div>
      {field("refundTerms", "Refund terms *", <textarea id={`${id}-refundTerms`} required minLength={10} maxLength={2000} rows={2} value={f.refundTerms} onChange={set("refundTerms")} />)}
      {field("dataHandling", "Data handling *", <textarea id={`${id}-dataHandling`} required minLength={10} maxLength={2000} rows={2} value={f.dataHandling} onChange={set("dataHandling")} />)}
      <button type="submit" className="btn btn-primary" disabled={!m.canAct || action.busy || !price?.ok || f.payoutVersionId === ""}>
        Create version
      </button>
      <ErrorNotice error={action.error} what="version not created" />
    </form>
  );
}

function Earnings({ d }: { d: SellerDashboard }) {
  const m = useMarket();
  const decimalsFor = m.decimalsFor;
  return (
    <Section title="Earnings">
      <p className="notice small" role="note">
        {NO_BALANCE_NOTE}
      </p>
      {d.totals.length === 0 ? (
        <p className="muted">No settled payments yet.</p>
      ) : (
        d.totals.map((t) => {
          const dec = decimalsFor(t.mint, t.network);
          return (
            <div key={`${t.network}|${t.mint}`} className="meter">
              <h3>
                <FullValue value={`${t.network} · ${t.mint}`} />
              </h3>
              <KV
                rows={[
                  ["Gross", <Money key="g" amount={t.gross} decimals={dec} />],
                  ["Platform fee", <Money key="f" amount={t.platformFee} decimals={dec} />],
                  ["Refunded", <Money key="r" amount={t.refunded} decimals={dec} />],
                  ["Net", <Money key="n" amount={t.net} decimals={dec} />],
                ]}
              />
            </div>
          );
        })
      )}
      {d.earnings.length > 0 ? (
        <div className="table-wrap">
          <table>
            <caption>Settled receipt history</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Type</th>
                <th scope="col">Amount</th>
                <th scope="col">Job</th>
              </tr>
            </thead>
            <tbody>
              {d.earnings.map((e, i) => (
                <tr key={`${e.job_id}-${e.event_type}-${i}`}>
                  <td>{when(e.created_at)}</td>
                  <td>{e.event_type}</td>
                  <td>
                    <Money amount={e.event_type === "refund" ? e.refund : e.gross} decimals={decimalsFor(e.mint, e.network)} />
                  </td>
                  <td>
                    <Link href={`/marketplace/jobs/${e.job_id}`}>{shortKey(e.job_id, 4)}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Section>
  );
}

function AssignedJobs({ d }: { d: SellerDashboard }) {
  const m = useMarket();
  const versionIds = new Set(d.versions.map((v) => v.id));
  const jobs = d.jobs.filter((j) => versionIds.has(j.listing_version_id));
  const jobIds = jobs.map((j) => j.id);
  const key = jobIds.join(",");
  const refunds = useResource(async () => {
    if (jobIds.length === 0) return [] as RefundRow[];
    const { data, error } = await supabase()
      .from("refund_requests")
      .select("id, job_id, amount:amount::text, status, reason, return_address, refund_signature, created_at")
      .in("job_id", jobIds)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as RefundRow[];
  }, `seller-refunds:${key}`);
  const open = (refunds.data ?? []).filter((r) => r.status === "requested" || r.status === "approved" || r.status === "uncertain");
  return (
    <>
      <Section title="Refund decisions">
        {refunds.loading && !refunds.data ? <Loading label="refund requests" /> : null}
        <ErrorNotice error={refunds.error} what="refund requests could not be loaded" onRetry={refunds.reload} />
        {refunds.data && open.length === 0 ? <p className="muted">No refund requests need a decision.</p> : null}
        <ul className="plain">
          {open.map((r) => (
            <li key={r.id}>
              <Link href={`/marketplace/jobs/${r.job_id ?? ""}`}>Job {shortKey(r.job_id ?? "", 4)}</Link>
              <ul className="plain">
                <RefundItem r={r} decimals={m.token?.decimals ?? null} isSeller onChanged={refunds.reload} />
              </ul>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Assigned jobs">
        {jobs.length === 0 ? (
          <p className="muted">No jobs assigned to your listings yet.</p>
        ) : (
          <ul className="activity job-list">
            {jobs.map((j) => (
              <li key={j.id} className="job-row">
                <div className="job-row-head">
                  <Link href={`/marketplace/jobs/${j.id}`} className="activity-label">
                    Job {shortKey(j.id, 4)}
                  </Link>
                  <span className="small muted">updated {when(j.updated_at)}</span>
                </div>
                <JobStates p={presentJob(j)} />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
