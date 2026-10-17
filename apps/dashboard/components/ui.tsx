"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ApiError } from "../lib/api";
import { explorerTx, shortKey } from "../lib/format";

/** What the owner can do about a backend error; the backend message is always shown verbatim as well. */
export function errorGuidance(error: ApiError): string | null {
  if (error.code === "NOT_READY") {
    return "A service or credential this view needs is not available. This is a missing capability, not a failed payment or a stopped agent. Start or configure the service (docs/configuration.md), then retry.";
  }
  if (error.status === 0 || error.code === "INTERNAL_ERROR") return "The dashboard could not complete the request. Check that the dashboard server is running, then retry.";
  if (error.status === 403) return "The request was refused. Reload the page; if it persists, sign out and sign in again.";
  if (error.status >= 500) return "The service reported an error. Nothing is assumed about the outcome of any payment: check Activity for the real state before retrying.";
  return null;
}

/** Shows a backend error verbatim; NOT_READY is presented as an unavailable capability, not a failure of the owner. */
export function ErrorNotice({ error, what, onRetry }: { error: ApiError | undefined; what?: string; onRetry?: () => void | Promise<void> }) {
  if (!error) return null;
  const notReady = error.code === "NOT_READY";
  const guidance = errorGuidance(error);
  return (
    <div role="alert" className={notReady ? "notice notice-warn" : "notice notice-error"}>
      <strong>{notReady ? "Not ready" : "Error"}</strong>
      {what ? ` — ${what}` : ""}: {error.message} <span className="code">({error.code})</span>
      {guidance ? <p className="small notice-help">{guidance}</p> : null}
      {onRetry ? (
        <button type="button" className="btn btn-small" onClick={() => void onRetry()}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

/** Empty list with the next action the owner can take. */
export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="muted">{children}</p>
      {action}
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const id = useId();
  useEffect(() => {
    if (open) confirmRef.current?.focus();
    else if (restoreFocus.current) {
      restoreFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);
  const dismiss = () => {
    restoreFocus.current = true;
    setOpen(false);
  };
  if (!open) {
    return (
      <button ref={triggerRef} type="button" className={danger ? "btn btn-danger" : "btn"} onClick={() => setOpen(true)} disabled={disabled}>
        {label}
      </button>
    );
  }
  return (
    <span
      className="confirm"
      role="group"
      aria-labelledby={id}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          dismiss();
        }
      }}
    >
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
      <button type="button" className="btn" onClick={dismiss}>
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
