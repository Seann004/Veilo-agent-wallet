"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ApiError } from "../lib/api";
import { explorerTx, shortKey } from "../lib/format";
import { reasonGuidance } from "../lib/labels";

/** What the owner can do about a backend error; the backend message is always shown verbatim as well. */
export function errorGuidance(error: ApiError): string | null {
  const byCode = reasonGuidance(error.code);
  if (byCode) return byCode;
  if (error.code === "NOT_READY") {
    return "This part isn't set up yet. It's not a failed payment or a stopped agent. Start the service (see docs/configuration.md), then retry.";
  }
  if (error.code === "WALLET_ERROR") {
    return "Your wallet didn't sign. Check it's unlocked and set to Solana devnet. A prepared transaction expires after about a minute, so prepare it again and sign straight away.";
  }
  if (error.status === 0 || error.code === "INTERNAL_ERROR") return "Couldn't reach the server. Check it's running, then retry.";
  if (error.status === 403) return "Not allowed. Reload the page; if it keeps happening, sign out and back in.";
  if (error.status >= 500) return "The service hit an error. Check Activity for the real payment state before retrying.";
  return null;
}

/** Shows a backend error verbatim; NOT_READY is presented as an unavailable capability, not a failure of the owner. */
export function ErrorNotice({ error, what, onRetry }: { error: ApiError | undefined; what?: string; onRetry?: () => void | Promise<void> }) {
  if (!error) return null;
  const notReady = error.code === "NOT_READY";
  const guidance = errorGuidance(error);
  return (
    <div role="alert" className={notReady ? "notice notice-warn error-notice" : "notice notice-error error-notice"}>
      <div>
        <strong>
          {notReady ? "Not available" : "Something went wrong"}
          {what ? `: ${what}` : ""}
        </strong>
        {guidance ? <p className="small flush">{guidance}</p> : null}
        <p className="small muted flush error-detail">
          {error.message} ({error.code})
        </p>
      </div>
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

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}

export function Loading({ label }: { label: string }) {
  return (
    <p role="status" aria-live="polite" className="loading muted">
      <Spinner /> Loading {label}…
    </p>
  );
}

/** Two-step button for consequential owner actions; the second step must be pressed explicitly. */
export function ConfirmButton({
  label,
  display,
  confirmLabel,
  onConfirm,
  disabled,
  danger,
  warning,
}: {
  label: string;
  /** Shorter visible text; `label` stays the accessible name. */
  display?: ReactNode;
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
      <button ref={triggerRef} type="button" className={danger ? "btn btn-danger" : "btn"} onClick={() => setOpen(true)} disabled={disabled} aria-label={display ? label : undefined}>
        {display ?? label}
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

/** Short reason next to a control the current role cannot use. Renders nothing when allowed. */
export function DeniedHint({ reason }: { reason: string | null }) {
  return reason ? <p className="hint access-hint">{reason}</p> : null;
}
