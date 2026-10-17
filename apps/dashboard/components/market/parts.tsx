"use client";

import { useEffect, useState, type ReactNode } from "react";
import { shortKey } from "../../lib/format";
import { formatUnits } from "../../lib/market/amounts";
import type { JobPresentation } from "../../lib/market/job-state";
import { TEST_TOKEN_LABEL } from "../../lib/market/messages";
import { useMarket } from "./MarketContext";

const GLYPH = { ok: "✓", wait: "…", problem: "!", idle: "·" } as const;

/** A token amount as an exact decimal string, always carrying the test-token label. */
export function Money({ amount, decimals, unit = "test tokens" }: { amount: unknown; decimals: number | null | undefined; unit?: string }) {
  const text = decimals === null || decimals === undefined ? null : formatUnits(amount, decimals);
  return (
    <span className="money">
      {text === null ? <span className="muted">amount unavailable</span> : `${text} ${unit}`}
      <span className="token-label"> ({TEST_TOKEN_LABEL})</span>
    </span>
  );
}

export function TestTokenNote() {
  return (
    <p className="token-note" role="note">
      {TEST_TOKEN_LABEL}
    </p>
  );
}

/** Untrusted text from sellers, buyers or results: rendered as text nodes only, line breaks kept. */
export function PlainText({ text, className }: { text: string | null | undefined; className?: string }) {
  return <div className={className ? `plain-text ${className}` : "plain-text"}>{text ?? ""}</div>;
}

/** Execution and payment as two separate indicators, each with its own words. */
export function JobStates({ p }: { p: JobPresentation }) {
  return (
    <ul className="state-strip state-strip-2" aria-label="Execution and payment states">
      {[p.execution, p.financial].map((s) => (
        <li key={s.axis} className={`state state-${s.tone}`} data-axis={s.axis}>
          <span className="state-group">{s.axis}</span>
          <span className="state-text">
            <span aria-hidden="true">{GLYPH[s.tone]} </span>
            {s.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Address({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="muted">—</span>;
  return (
    <span className="mono" title={value}>
      <span aria-hidden="true">{shortKey(value, 6)}</span>
      <span className="sr-only">{value}</span>
    </span>
  );
}

/** Full value for things the buyer must be able to compare exactly (recipient, digest). */
export function FullValue({ value }: { value: string | null | undefined }) {
  return <span className="mono wrap-anywhere">{value ?? "—"}</span>;
}

/** Seconds left until an ISO deadline, refreshed every second. */
export function Countdown({ until, onExpire }: { until: string; onExpire?: () => void }) {
  const end = Date.parse(until);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.floor((end - now) / 1000));
  useEffect(() => {
    if (left === 0 && onExpire) onExpire();
  }, [left, onExpire]);
  if (!Number.isFinite(end)) return <span className="muted">unknown</span>;
  if (left === 0) return <span className="pill pill-danger">Expired</span>;
  const m = Math.floor(left / 60);
  const s = left % 60;
  return (
    <span className={left < 60 ? "pill pill-warn" : "pill"}>
      <span aria-hidden="true">
        {m}:{String(s).padStart(2, "0")}
      </span>
      <span className="sr-only">
        {m} minutes {s} seconds
      </span>{" "}
      left
    </span>
  );
}

/** Renders children only for a signed-in marketplace user; otherwise explains what is needed. */
export function RequireMarketSession({ children, what }: { children: ReactNode; what: string }) {
  const m = useMarket();
  if (!m.configured) {
    return (
      <p className="notice notice-warn" role="status">
        The marketplace is not configured for this dashboard.
      </p>
    );
  }
  if (!m.ready) {
    return (
      <p role="status" className="muted">
        Checking marketplace sign-in…
      </p>
    );
  }
  if (!m.me) {
    return (
      <p className="notice" role="status">
        Sign in to the marketplace with your wallet (above) to {what}.
      </p>
    );
  }
  return <>{children}</>;
}

export function PausedNotice() {
  const m = useMarket();
  if (!m.mismatch) return null;
  return (
    <p className="notice notice-warn" role="alert">
      Actions are paused: your wallet switched accounts. Sign in again to continue.
    </p>
  );
}
