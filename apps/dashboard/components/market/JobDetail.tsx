"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { when } from "../../lib/format";
import { formatUnits, parseUnits, sumUnits, toBaseUnits } from "../../lib/market/amounts";
import { trustedDownloadUrl } from "../../lib/market/client";
import { presentJob } from "../../lib/market/job-state";
import type { ArtifactRow, JobDetail as JobDetailData, RefundRow } from "../../lib/market/types";
import { useAction, useResource } from "../hooks";
import { ConfirmButton, ErrorNotice, KV, Loading, Section, TxLink } from "../ui";
import { POLL_MS } from "./JobBoard";
import { useMarket } from "./MarketContext";
import { Countdown, FullValue, JobStates, Money, PausedNotice, PlainText, RequireMarketSession, TestTokenNote } from "./parts";

const CANCELLABLE = new Set(["created", "awaiting_approval", "awaiting_payment", "queued", "running", "input_required"]);
const LIVE_REFUND = new Set(["requested", "approved", "submitted", "uncertain", "finalized"]);

export function JobDetail({ jobId }: { jobId: string }) {
  return (
    <>
      <p className="small">
        <Link href="/marketplace/jobs">← Jobs</Link>
      </p>
      <RequireMarketSession what="see this job">
        <JobView jobId={jobId} />
      </RequireMarketSession>
    </>
  );
}

function JobView({ jobId }: { jobId: string }) {
  const m = useMarket();
  const res = useResource(() => m.call<JobDetailData>(`/jobs/${encodeURIComponent(jobId)}`), `job:${jobId}:${m.me?.userId ?? ""}`);
  const live = res.data ? presentJob(res.data.job, { hasReceipt: res.data.receipt !== null }).live : false;
  const { reload } = res;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(t);
  }, [live, reload]);

  if (res.loading && !res.data) return <Loading label="job" />;
  if (!res.data) return <ErrorNotice error={res.error} what="the job could not be loaded" onRetry={res.reload} />;
  const d = res.data;
  const p = presentJob(d.job, { hasReceipt: d.receipt !== null });
  const isBuyer = d.job.buyer_workspace_id !== undefined && d.job.buyer_workspace_id === m.me?.workspace?.id;
  const isSeller = d.job.seller_id !== undefined && d.job.seller_id === m.me?.seller?.id;
  const decimals = d.quote?.fields.decimals ?? null;
  const brief = d.inputs.find((i) => i.kind === "brief");

  return (
    <>
      <h1>Job</h1>
      <p className="small muted mono wrap-anywhere">{d.job.id}</p>
      <p className="small">{isBuyer ? "You hired this specialist." : isSeller ? "This job is assigned to you as the seller." : null}</p>
      <TestTokenNote />
      <JobStates p={p} />
      {p.notes.map((n) => (
        <p key={n} className="notice notice-warn" role="status">
          {n}
        </p>
      ))}
      <ErrorNotice error={res.error} what="refresh failed; showing the last loaded state" onRetry={res.reload} />
      {live ? (
        <p className="small muted" role="status">
          Refreshing every {POLL_MS / 1000} seconds until the job and its payment settle.
        </p>
      ) : null}
      <PausedNotice />
      <div className="grid-2">
        <QuotePanel d={d} isBuyer={isBuyer} onChanged={res.reload} />
        <ReceiptPanel d={d} decimals={decimals} />
      </div>
      {isBuyer && CANCELLABLE.has(d.job.state) ? <CancelJob jobId={d.job.id} onChanged={res.reload} /> : null}
      <Section title="Brief and input requests">
        {brief ? <PlainText text={brief.body} className="brief" /> : <p className="muted">No brief recorded.</p>}
        <Inputs d={d} isBuyer={isBuyer} onChanged={res.reload} />
      </Section>
      <Section title="Deliverables">
        <Artifacts artifacts={d.artifacts} />
      </Section>
      <Section title="Refunds">
        <Refunds d={d} decimals={decimals} isBuyer={isBuyer} isSeller={isSeller} paidWithoutResult={p.paidWithoutResult} onChanged={res.reload} />
      </Section>
      <Section title="Timeline">
        {d.events.length === 0 ? (
          <p className="muted">No events recorded.</p>
        ) : (
          <ol className="timeline">
            {d.events.map((e) => (
              <li key={e.seq}>
                <span className="mono">{e.kind}</span>
                {e.from_state || e.to_state ? (
                  <span className="small">
                    {" "}
                    {e.from_state ?? "—"} → {e.to_state ?? "—"}
                  </span>
                ) : null}
                <span className="small muted">
                  {" "}
                  · {e.actor_type} · {when(e.created_at)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </>
  );
}

function QuotePanel({ d, isBuyer, onChanged }: { d: JobDetailData; isBuyer: boolean; onChanged: () => Promise<void> }) {
  const m = useMarket();
  const action = useAction();
  const q = d.quote;
  if (!q) {
    return (
      <Section title="Quote">
        <p className="muted">No quote is visible for this job.</p>
      </Section>
    );
  }
  const f = q.fields;
  const pending = d.job.state === "awaiting_approval" || d.job.state === "awaiting_payment";
  return (
    <Section title="Quote">
      <KV
        rows={[
          ["Total", <Money key="t" amount={q.total_units} decimals={f.decimals} />],
          ["Platform fee", toBaseUnits(q.fee_units) === "0" ? "0 (zero platform fee)" : <Money key="f" amount={q.fee_units} decimals={f.decimals} />],
          ["Recipient", <FullValue key="r" value={q.recipient} />],
          ["Network / mint", <FullValue key="n" value={`${q.network} · ${q.mint}`} />],
          ["Expires", pending ? <Countdown key="e" until={q.expires_at} /> : when(q.expires_at)],
          ["Quote digest", <FullValue key="d" value={q.quote_digest} />],
          ["Payment request", d.payment ? `${d.payment.status}${d.payment.reject_code ? ` (${d.payment.reject_code})` : ""}` : "not opened"],
        ]}
      />
      {d.job.state === "awaiting_payment" ? (
        <p className="notice small" role="note">
          Your local controller must still authorize and pay this quote. Marketplace sign-in cannot.{" "}
          <Link href="/marketplace/approvals">Open local approval</Link>
        </p>
      ) : null}
      {isBuyer && d.job.state === "awaiting_approval" ? (
        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!m.canAct || action.busy}
            onClick={() =>
              void action.run(async () => {
                await m.call(`/jobs/${d.job.id}/approve`, { method: "POST", body: {} });
                await onChanged();
              })
            }
          >
            Approve quote
          </button>
          <span className="small muted">Approval records intent; the local controller authorizes payment.</span>
        </div>
      ) : null}
      <ErrorNotice error={action.error} what="approval failed" />
    </Section>
  );
}

function ReceiptPanel({ d, decimals }: { d: JobDetailData; decimals: number | null }) {
  const r = d.receipt;
  return (
    <Section title="Settlement receipt">
      {r ? (
        <KV
          rows={[
            ["Amount", <Money key="a" amount={r.amount} decimals={decimals} />],
            ["Signature", <TxLink key="s" signature={r.signature} />],
            ["Finalized slot", String(r.finalized_slot)],
            ["Verified", when(r.verified_at)],
          ]}
        />
      ) : (
        <p className="muted">No settled payment is recorded for this job.</p>
      )}
    </Section>
  );
}

function CancelJob({ jobId, onChanged }: { jobId: string; onChanged: () => Promise<void> }) {
  const m = useMarket();
  const action = useAction();
  const [result, setResult] = useState<string | null>(null);
  return (
    <div className="actions">
      <ConfirmButton
        label="Cancel job"
        confirmLabel="Confirm cancel"
        danger
        disabled={!m.canAct || action.busy}
        warning="Cancelling before payment stops the job. After payment it asks the seller to stop; a payment already made stays recorded."
        onConfirm={() =>
          void action.run(async () => {
            const r = await m.call<{ state: string }>(`/jobs/${jobId}/cancel`, { method: "POST", body: {} });
            setResult(r.state);
            await onChanged();
          })
        }
      />
      {result ? <span role="status">Result: {result}</span> : null}
      <ErrorNotice error={action.error} what="cancel failed" />
    </div>
  );
}

function Inputs({ d, isBuyer, onChanged }: { d: JobDetailData; isBuyer: boolean; onChanged: () => Promise<void> }) {
  const m = useMarket();
  const action = useAction();
  const [body, setBody] = useState("");
  const id = useId();
  const exchanges = d.inputs.filter((i) => i.kind !== "brief");
  return (
    <>
      {exchanges.length > 0 ? (
        <ol className="plain exchanges">
          {exchanges.map((i) => (
            <li key={i.id}>
              <strong>{i.kind === "question" ? "Seller asked" : i.kind === "response" ? "You answered" : i.kind}</strong>{" "}
              <span className="small muted">{when(i.created_at)}</span>
              <PlainText text={i.body} />
            </li>
          ))}
        </ol>
      ) : (
        <p className="small muted">No input requests.</p>
      )}
      {isBuyer && d.job.state === "input_required" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await m.call(`/jobs/${d.job.id}/inputs`, { method: "POST", body: { body: body.trim() } });
              setBody("");
              await onChanged();
            });
          }}
        >
          <div className="field">
            <label htmlFor={id}>Your answer *</label>
            <textarea id={id} required rows={4} maxLength={16_000} value={body} onChange={(e) => setBody(e.target.value)} />
            {d.job.input_deadline ? <span className="hint">Answer before {when(d.job.input_deadline)}.</span> : null}
          </div>
          <button type="submit" className="btn btn-primary" disabled={!m.canAct || action.busy || body.trim() === ""}>
            Send answer
          </button>
          <ErrorNotice error={action.error} what="the answer was not sent" />
        </form>
      ) : null}
    </>
  );
}

function Artifacts({ artifacts }: { artifacts: ArtifactRow[] }) {
  const m = useMarket();
  const action = useAction();
  if (artifacts.length === 0) return <p className="muted">No deliverables yet.</p>;
  return (
    <>
      <p className="small muted">Deliverables are downloaded as files and never displayed inside this page.</p>
      <ul className="plain">
        {artifacts.map((a) => (
          <li key={a.id} className="artifact">
            <span className="mono">{a.mime_type}</span> · {a.bytes.toLocaleString("en-US")} bytes · v{a.version} ·{" "}
            <span className={a.validation_state === "validated" ? "pill pill-ok" : "pill pill-warn"}>{a.validation_state}</span>
            <span className="small muted mono wrap-anywhere"> sha256 {a.sha256}</span>{" "}
            <button
              type="button"
              className="btn btn-small"
              disabled={!m.canAct || action.busy || a.validation_state !== "validated"}
              onClick={() =>
                void action.run(async () => {
                  const r = await m.call<{ url: string }>(`/artifacts/${a.id}/download`, { method: "POST", body: {} });
                  const url = trustedDownloadUrl(r.url);
                  if (!url) throw new Error("the download link does not point at the configured storage origin");
                  window.location.assign(url);
                })
              }
            >
              Download
            </button>
          </li>
        ))}
      </ul>
      <ErrorNotice error={action.error} what="download failed" />
    </>
  );
}

function Refunds({
  d,
  decimals,
  isBuyer,
  isSeller,
  paidWithoutResult,
  onChanged,
}: {
  d: JobDetailData;
  decimals: number | null;
  isBuyer: boolean;
  isSeller: boolean;
  paidWithoutResult: boolean;
  onChanged: () => Promise<void>;
}) {
  const paid = toBaseUnits(d.receipt?.amount);
  const claimed = sumUnits(d.refunds.filter((r) => LIVE_REFUND.has(r.status)).map((r) => r.amount));
  const remaining = paid !== null && claimed !== null ? BigInt(paid) - BigInt(claimed) : null;
  return (
    <>
      {d.refunds.length === 0 ? (
        <p className="muted">No refund requests.</p>
      ) : (
        <ul className="plain">
          {d.refunds.map((r) => (
            <RefundItem key={r.id} r={r} decimals={decimals} isSeller={isSeller} onChanged={onChanged} />
          ))}
        </ul>
      )}
      {isBuyer && d.receipt ? (
        remaining === null || remaining > 0n ? (
          <>
            {paidWithoutResult ? <p className="small notice notice-warn">This job was paid but did not deliver a result. You can ask the seller for a refund.</p> : null}
            <RefundRequest jobId={d.job.id} decimals={decimals} remaining={remaining} onChanged={onChanged} />
          </>
        ) : (
          <p className="small muted">The full paid amount is already covered by refund requests.</p>
        )
      ) : isBuyer ? (
        <p className="small muted">Refunds can be requested only after a settled payment.</p>
      ) : null}
    </>
  );
}

export function RefundItem({ r, decimals, isSeller, onChanged }: { r: RefundRow; decimals: number | null; isSeller: boolean; onChanged: () => Promise<void> }) {
  const m = useMarket();
  const action = useAction();
  const [sig, setSig] = useState("");
  const id = useId();
  return (
    <li className="refund">
      <Money amount={r.amount} decimals={decimals} /> · <span className="pill">{r.status}</span> <span className="small muted">{when(r.created_at)}</span>
      <PlainText text={r.reason} className="small" />
      {r.refund_signature ? (
        <p className="small">
          Refund transaction: <TxLink signature={r.refund_signature} />
        </p>
      ) : null}
      {isSeller && r.status === "requested" ? (
        <div className="actions">
          <ConfirmButton
            label="Approve refund"
            confirmLabel="Confirm approve refund"
            disabled={!m.canAct || action.busy}
            warning="You then send the refund yourself from your payout wallet and submit its signature."
            onConfirm={() =>
              void action.run(async () => {
                await m.call(`/refunds/${r.id}/decision`, { method: "POST", body: { approve: true } });
                await onChanged();
              })
            }
          />
          <ConfirmButton
            label="Decline refund"
            confirmLabel="Confirm decline refund"
            danger
            disabled={!m.canAct || action.busy}
            onConfirm={() =>
              void action.run(async () => {
                await m.call(`/refunds/${r.id}/decision`, { method: "POST", body: { approve: false } });
                await onChanged();
              })
            }
          />
        </div>
      ) : null}
      {isSeller && (r.status === "approved" || r.status === "uncertain") ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await m.call(`/refunds/${r.id}/submitted`, { method: "POST", body: { signature: sig.trim() } });
              setSig("");
              await onChanged();
            });
          }}
        >
          <div className="field">
            <label htmlFor={id}>Refund transaction signature *</label>
            <input id={id} required className="mono" value={sig} onChange={(e) => setSig(e.target.value)} pattern="[1-9A-HJ-NP-Za-km-z]{64,90}" aria-describedby={`${id}-h`} />
            <span id={`${id}-h`} className="hint">
              Send exactly this amount to {r.return_address ?? "the buyer's return address"} from your payout wallet, then paste the devnet
              signature. It counts only once the marketplace verifies the finalized transfer.
            </span>
          </div>
          <button type="submit" className="btn btn-primary" disabled={!m.canAct || action.busy || sig.trim() === ""}>
            Submit refund signature
          </button>
        </form>
      ) : null}
      <ErrorNotice error={action.error} what="refund action failed" />
    </li>
  );
}

function RefundRequest({ jobId, decimals, remaining, onChanged }: { jobId: string; decimals: number | null; remaining: bigint | null; onChanged: () => Promise<void> }) {
  const m = useMarket();
  const action = useAction();
  const wallets = m.me?.wallets ?? [];
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState(wallets[0]?.address ?? "");
  const [reason, setReason] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const ids = { amount: useId(), to: useId(), reason: useId() };
  const parsed = decimals === null ? null : parseUnits(amount, decimals);
  const tooMuch = parsed?.ok === true && remaining !== null && BigInt(parsed.value) > remaining;
  const zero = parsed?.ok === true && BigInt(parsed.value) === 0n;
  const amountError = amount === "" ? null : parsed === null ? "token decimals unknown" : !parsed.ok ? parsed.error : zero ? "must be more than zero" : tooMuch ? "more than the remaining refundable amount" : null;
  return (
    <form
      className="refund-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!parsed?.ok || amountError) return;
        void action.run(async () => {
          const r = await m.call<{ refundId: string; note: string }>(`/jobs/${jobId}/refund-requests`, {
            method: "POST",
            body: { amount: parsed.value, returnAddress: to, reason: reason.trim() },
          });
          setDone(r.note);
          setAmount("");
          setReason("");
          await onChanged();
        });
      }}
    >
      <h3>Request a refund</h3>
      {remaining !== null && decimals !== null ? (
        <p className="small">
          Refundable at most: {formatUnits(remaining.toString(), decimals)} test tokens (paid amount minus refunds already requested).
        </p>
      ) : null}
      <div className="grid-2">
        <div className="field">
          <label htmlFor={ids.amount}>Amount *</label>
          <input id={ids.amount} inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={amountError ? true : undefined} aria-describedby={`${ids.amount}-e`} />
          <span id={`${ids.amount}-e`} className={amountError ? "hint field-error" : "hint"} role={amountError ? "alert" : undefined}>
            {amountError ?? "Decimal amount in test tokens."}
          </span>
        </div>
        <div className="field">
          <label htmlFor={ids.to}>Return address *</label>
          {wallets.length === 0 ? (
            <p className="small notice notice-warn">No verified wallet on this account.</p>
          ) : (
            <select id={ids.to} value={to} onChange={(e) => setTo(e.target.value)}>
              {wallets.map((w) => (
                <option key={w.address} value={w.address}>
                  {w.address}
                </option>
              ))}
            </select>
          )}
          <span className="hint">Only wallets verified on your marketplace account can receive refunds.</span>
        </div>
      </div>
      <div className="field">
        <label htmlFor={ids.reason}>Reason *</label>
        <textarea id={ids.reason} required rows={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <button type="submit" className="btn btn-primary" disabled={!m.canAct || action.busy || !parsed?.ok || amountError !== null || to === "" || reason.trim() === ""}>
        Request refund
      </button>
      <p className="small muted">Refunds are seller-funded and counted only once the transfer is finalized on chain.</p>
      {done ? (
        <p role="status" className="notice">
          Refund requested. {done}
        </p>
      ) : null}
      <ErrorNotice error={action.error} what="refund request failed" />
    </form>
  );
}
