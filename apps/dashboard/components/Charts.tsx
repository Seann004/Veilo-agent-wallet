"use client";

import { useState, type ReactNode } from "react";
import { usdc } from "../lib/format";
import { percent, type DaySpend } from "../lib/spend";
import { Amount } from "./UsdcIcon";

export function Stat({ label, value, sub, children }: { label: string; value: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">
        <Amount value={value} />
      </span>
      {children}
      {sub ? <span className="stat-sub">{sub}</span> : null}
    </div>
  );
}

/** A remaining-versus-limit bar. The fill is what is left; text always carries the numbers too. */
export function Meter({ left, limit, label, tone }: { left: string; limit: string; label: string; tone?: "ok" | "low" | "out" }) {
  const pct = percent(left, limit);
  const t = tone ?? (pct === 0 ? "out" : pct < 20 ? "low" : "ok");
  return (
    <span
      className={`budget-meter budget-meter-${t}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-valuetext={`${usdc(left)} left of ${usdc(limit)}`}
    >
      <span className="budget-meter-fill" style={{ width: `${pct}%` }} />
    </span>
  );
}

export interface Segment {
  key: string;
  label: string;
  /** Base units. */
  value: string;
  /** Chart colour slot, 1–3; 0 is the neutral "everything else" fill. */
  slot: 0 | 1 | 2 | 3;
  hint?: ReactNode;
}

/** Part-to-whole bar with a legend that always lists each value; hovering a part highlights its row. */
export function StackedBar({ segments, label }: { segments: Segment[]; label: string }) {
  const [active, setActive] = useState<string | null>(null);
  const total = segments.reduce((a, s) => a + BigInt(s.value), 0n);
  return (
    <div className="stacked" onPointerLeave={() => setActive(null)}>
      <div className="stacked-bar" role="img" aria-label={`${label}: ${segments.map((s) => `${s.label} ${usdc(s.value)}`).join(", ")}`}>
        {total === 0n ? <span className="stacked-empty" /> : null}
        {segments.map((s) =>
          s.value === "0" ? null : (
            <span
              key={s.key}
              className={`stacked-seg slot-${s.slot}${active && active !== s.key ? " dim" : ""}`}
              style={{ flexGrow: percent(s.value, total) }}
              onPointerEnter={() => setActive(s.key)}
            />
          ),
        )}
      </div>
      <ul className="legend">
        {segments.map((s) => (
          <li key={s.key} className={active === s.key ? "active" : undefined} onPointerEnter={() => setActive(s.key)}>
            <span className={`swatch slot-${s.slot}`} aria-hidden="true" />
            <span className="legend-label">
              {s.label}
              {s.hint ? <span className="legend-hint">{s.hint}</span> : null}
            </span>
            <span className="legend-value">{usdc(s.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const dayName = (d: Date) => new Intl.DateTimeFormat("en-GB", { weekday: "short" }).format(d);
const dayFull = (d: Date) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(d);

/** A clean axis top: the next 1, 2 or 5 step at or above the largest value (base units). */
function niceMax(v: bigint): bigint {
  if (v <= 0n) return 1_000_000n;
  let step = 10_000n;
  for (;;) {
    for (const m of [1n, 2n, 5n]) if (step * m >= v) return step * m;
    step *= 10n;
  }
}

/**
 * Daily paid-on-chain columns with the rolling 24 h limit as a reference line. Each column takes
 * focus, shows its value on hover or focus and names it for screen readers.
 */
export function DailyBars({ days, limit }: { days: DaySpend[]; limit: string | null }) {
  const peak = days.reduce((m, d) => (d.total > m ? d.total : m), 0n);
  const top = niceMax(limit && BigInt(limit) > peak ? BigInt(limit) : peak);
  const ticks = [top, top / 2n, 0n];
  const limitPct = limit ? percent(limit, top) : null;
  return (
    <div className="daybars">
      <div className="daybars-plot">
        <div className="daybars-grid" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t.toString()} className="daybars-tick" style={{ bottom: `${percent(t, top)}%` }}>
              <span>{usdc(t.toString()).replace(" USDC", "")}</span>
            </span>
          ))}
          {limitPct !== null ? (
            <span className="daybars-limit" style={{ bottom: `${limitPct}%` }}>
              <span>24 h limit</span>
            </span>
          ) : null}
        </div>
        <ol className="daybars-cols">
          {days.map((d, i) => (
            <li key={d.start.toISOString()} tabIndex={0} role="img" aria-label={`${dayFull(d.start)}: ${usdc(d.total.toString())} paid${d.count ? `, ${d.count} payment${d.count === 1 ? "" : "s"}` : ""}`}>
              <span className="daybars-bar" style={{ height: `${percent(d.total, top)}%` }} data-zero={d.total === 0n ? "" : undefined} />
              <span className="daybars-tip" aria-hidden="true">
                <strong>{usdc(d.total.toString())}</strong>
                <span>{dayFull(d.start)}</span>
              </span>
              <span className="daybars-x" aria-hidden="true">
                {i === days.length - 1 ? "Today" : dayName(d.start)}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export interface AgentSpendRow {
  id: string;
  name: string;
  avatar: ReactNode;
  spent: string;
  held: string;
}

/** Horizontal bars of USDC spent (and still held) per agent, scaled to the largest agent. */
export function AgentSpendBars({ rows }: { rows: AgentSpendRow[] }) {
  const max = rows.reduce((m, r) => {
    const t = BigInt(r.spent) + BigInt(r.held);
    return t > m ? t : m;
  }, 0n);
  return (
    <>
      <ul className="legend legend-inline" aria-label="Legend">
        <li>
          <span className="swatch slot-1" aria-hidden="true" />
          Paid
        </li>
        <li>
          <span className="swatch slot-2" aria-hidden="true" />
          Held for live purchases
        </li>
      </ul>
      <ul className="hbars">
        {rows.map((r) => (
          <li key={r.id}>
            {r.avatar}
            <span className="hbars-name" title={r.name}>
              {r.name}
            </span>
            <span className="hbars-track" aria-hidden="true">
              <span className="hbars-seg slot-1" style={{ width: `${percent(r.spent, max)}%` }} />
              {r.held !== "0" ? <span className="hbars-seg slot-2" style={{ width: `${percent(r.held, max)}%` }} /> : null}
            </span>
            <span className="hbars-value">
              {usdc(r.spent)}
              {r.held !== "0" ? <span className="muted small"> +{usdc(r.held).replace(" USDC", "")} held</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
