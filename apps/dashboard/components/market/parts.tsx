"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { AVATARS, type AvatarOption } from "../../lib/avatar-options";
import { shortKey } from "../../lib/format";
import { formatUnits } from "../../lib/market/amounts";
import type { JobPresentation } from "../../lib/market/job-state";
import { DECIMALS_UNVERIFIED, TEST_TOKEN_LABEL } from "../../lib/market/messages";
import { toBaseUnits } from "../../lib/market/amounts";
import { useMarket } from "./MarketContext";
import { AvatarImage } from "../Avatar";
import { UsdcIcon } from "../UsdcIcon";

const GLYPH = { ok: "✓", wait: "…", problem: "!", idle: "·" } as const;

/**
 * A token amount: the exact integer base units always, plus a decimal rendering only when the
 * local controller has verified the mint's decimals. Always carries the test-token label.
 */
export function Money({ amount, decimals, unit = "USDC", compact = false }: { amount: unknown; decimals: number | null | undefined; unit?: string; compact?: boolean }) {
  const raw = toBaseUnits(amount);
  const text = decimals === null || decimals === undefined ? null : formatUnits(amount, decimals);
  // Cards show the amount alone; the exact base units stay available on hover.
  if (compact && raw !== null && text !== null) {
    return (
      <span className="money amount-usdc" title={`${raw} base units (${TEST_TOKEN_LABEL})`}>
        {unit === "USDC" ? <UsdcIcon size={16} /> : null}
        {text} {unit}
      </span>
    );
  }
  if (raw === null) {
    return (
      <span className="money">
        <span className="muted">amount unavailable</span>
        <span className="token-label"> ({TEST_TOKEN_LABEL})</span>
      </span>
    );
  }
  return (
    <span className="money">
      {text === null ? (
        <>
          {raw} base units <span className="muted small">({DECIMALS_UNVERIFIED})</span>
        </>
      ) : (
        <>
          {text} {unit} <span className="mono small">= {raw} base units</span>
        </>
      )}
      <span className="token-label"> ({TEST_TOKEN_LABEL})</span>
    </span>
  );
}

/** Untrusted text from sellers, buyers or results: rendered as text nodes only, line breaks kept. */
export function PlainText({ text, className, inline }: { text: string | null | undefined; className?: string; inline?: boolean }) {
  if (inline) return <span className={className ? `inline-text ${className}` : "inline-text"}>{text ?? ""}</span>;
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

/** A stable avatar picture per name, so the same agent always looks the same. */
export function creatorAvatar(name: string): AvatarOption {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATARS[h % AVATARS.length]!;
}

/** Top of a marketplace detail page: back link, picture, name, creator, summary and main actions. */
export function DetailHeader({ avatar, title, by, summary, actions }: { avatar: AvatarOption; title: string; by: string; summary: string; actions?: ReactNode }) {
  return (
    <header className="detail-head">
      <Link href="/marketplace" className="back-link">
        ← Back to Marketplace
      </Link>
      <span className="detail-avatar-bot">
        <AvatarImage avatar={avatar} size={96} />
      </span>
      <h1>
        <PlainText text={title} inline />
      </h1>
      <p className="detail-by">
        By <PlainText text={by} inline />
      </p>
      <p className="detail-summary">
        <PlainText text={summary} inline />
      </p>
      {actions ? <div className="detail-actions">{actions}</div> : null}
    </header>
  );
}

export interface DetailSection {
  id: string;
  label: string;
  sub: string;
  body: ReactNode;
}

/**
 * Sections of a detail page: a menu on the left and the open section on the right. Switching
 * is local state, so the page never reloads or jumps to the top.
 */
export function DetailSections({ sections, open, onOpen }: { sections: DetailSection[]; open: string; onOpen: (id: string) => void }) {
  const current = sections.find((s) => s.id === open) ?? sections[0]!;
  return (
    <div className="detail-sections">
      <nav aria-label="Sections" className="detail-menu">
        {sections.map((s) => (
          <button key={s.id} type="button" aria-current={s.id === current.id ? "true" : undefined} onClick={() => onOpen(s.id)}>
            <span className="detail-menu-label">{s.label}</span>
            <span className="detail-menu-sub">{s.sub}</span>
          </button>
        ))}
      </nav>
      <section className="detail-panel" aria-label={current.label}>
        {current.body}
      </section>
    </div>
  );
}

export function turnaround(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "—";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.round((minutes / 60) * 10) / 10} h`;
  return `${Math.round((minutes / 1440) * 10) / 10} days`;
}
