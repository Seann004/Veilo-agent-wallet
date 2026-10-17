"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ApiError } from "../lib/api";
import { explorerTx, shortKey } from "../lib/format";

/** Shows a backend error verbatim; NOT_READY is presented as an unavailable capability, not a failure of the owner. */
export function ErrorNotice({ error, what }: { error: ApiError | undefined; what?: string }) {
  if (!error) return null;
  const notReady = error.code === "NOT_READY";
  return (
    <div role="alert" className={notReady ? "notice notice-warn" : "notice notice-error"}>
      <strong>{notReady ? "Not ready" : "Error"}</strong>
      {what ? ` — ${what}` : ""}: {error.message} <span className="code">({error.code})</span>
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <p role="status" aria-live="polite" className="muted">
      Loading {label}…
    </p>
  );
}

/** Two-step button for consequential owner actions; the second step must be pressed explicitly. */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled,
  danger,
  warning,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
  danger?: boolean;
  warning?: string;
}) {
  const [open, setOpen] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (open) confirmRef.current?.focus();
  }, [open]);
  if (!open) {
    return (
      <button type="button" className={danger ? "btn btn-danger" : "btn"} onClick={() => setOpen(true)} disabled={disabled}>
        {label}
      </button>
    );
  }
  return (
    <span className="confirm" role="group" aria-labelledby={id}>
      <span id={id} className="confirm-text">
        {warning ?? "Are you sure?"}
      </span>
      <button
        ref={confirmRef}
        type="button"
        className={danger ? "btn btn-danger" : "btn btn-primary"}
        onClick={async () => {
          setOpen(false);
          await onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button type="button" className="btn" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </span>
  );
}

export function TxLink({ signature, label }: { signature: string | null | undefined; label?: string }) {
  if (!signature) return <span className="muted">none recorded</span>;
  return (
    <a href={explorerTx(signature)} target="_blank" rel="noreferrer noopener" className="mono">
      {label ?? shortKey(signature, 8)} <span className="sr-only">(opens Solana devnet explorer)</span>↗
    </a>
  );
}

export function Section({ title, children, id, actions }: { title: string; children: ReactNode; id?: string; actions?: ReactNode }) {
  const hid = useId();
  return (
    <section className="panel" aria-labelledby={hid} id={id}>
      <div className="panel-head">
        <h2 id={hid}>{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function KV({ rows }: { rows: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="kv">
      {rows.map(([k, v], i) => (
        <div key={i} className="kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
