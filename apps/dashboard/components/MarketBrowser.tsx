"use client";

import Link from "next/link";
import { useState } from "react";
import { AVATARS, ROLE_AVATAR } from "../lib/avatar-options";
import { credits, usdc } from "../lib/format";
import { ROLE_LABEL } from "../lib/labels";
import { ROLE_ORDER as ROLES, ROLE_TAGLINE as TAGLINE } from "../lib/roles";
import type { AgentRole, Workspace } from "../lib/types";
import { Icon } from "./Icon";
import { ROLE_TEMPLATES } from "./Policy";
import { useCapability, useOwner } from "./Shell";

type Filter = "all" | "agents" | "services";
type Service = Workspace["services"][number];

const avatarFor = (role: AgentRole) => AVATARS.find((a) => a.id === ROLE_AVATAR[role]) ?? AVATARS[0]!;
function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

const matches = (q: string, ...fields: string[]) => q === "" || fields.some((f) => f.toLowerCase().includes(q));

function FeaturedRole({ role }: { role: AgentRole }) {
  const t = ROLE_TEMPLATES[role];
  const create = useCapability("create");
  const body = (
    <>
      <img className="featured-avatar" src={avatarFor(role).src} alt="" width={84} height={84} />
      <span className="featured-text">
        <span className="featured-name">{ROLE_LABEL[role]}</span>
        <span className="featured-sub">
          {usdc(t.policy.maxPurchaseTestUsdc)} per purchase · {usdc(t.policy.taskLimitTestUsdc)} per task
        </span>
      </span>
    </>
  );
  if (!create.allowed) {
    return (
      <div className={`featured featured-${role}`} id={role} title={create.reason ?? undefined}>
        {body}
      </div>
    );
  }
  return (
    <Link href={`/agents/new?role=${role}`} className={`featured featured-${role}`} id={role}>
      {body}
    </Link>
  );
}

function RoleRow({ role }: { role: AgentRole }) {
  const create = useCapability("create");
  return (
    <li className="market-row">
      <img className="avatar" src={avatarFor(role).src} alt="" width={40} height={40} />
      <span className="market-row-text">
        <strong>{ROLE_LABEL[role]}</strong>
        <span>{TAGLINE[role]}</span>
      </span>
      {create.allowed ? (
        <Link href={`/agents/new?role=${role}`} className="btn btn-small btn-pill" aria-label={`Hire ${ROLE_LABEL[role].toLowerCase()}`}>
          Hire
        </Link>
      ) : (
        <button type="button" className="btn btn-small btn-pill" disabled title={create.reason ?? undefined} aria-label={`Hire ${ROLE_LABEL[role].toLowerCase()} (owner only)`}>
          Hire
        </button>
      )}
    </li>
  );
}

function lowestPrice(s: Service): string {
  const cash = s.skus.filter((k) => k.enabled && k.paymentPath !== "prepaid_credits").map((k) => BigInt(k.priceUsdc));
  if (cash.length > 0) return `from ${usdc(cash.reduce((a, b) => (b < a ? b : a)).toString())}`;
  const units = s.skus.filter((k) => k.enabled).map((k) => BigInt(k.usageUnits));
  return units.length > 0 ? `from ${credits(units.reduce((a, b) => (b < a ? b : a)).toString())}` : "no enabled SKUs";
}

function ServiceRow({ s }: { s: Service }) {
  return (
    <li className="market-row market-row-service">
      <span className="service-icon" aria-hidden="true">
        <Icon name="store" size={18} />
      </span>
      <details className="market-row-text">
        <summary>
          <strong>{s.service_key}</strong>
          <span>
            {hostOf(s.origin)} · {lowestPrice(s)}
          </span>
        </summary>
        <ul className="sku-list">
          {s.skus.map((k) => (
            <li key={`${k.sku}-${k.paymentPath}`}>
              <span>
                {k.sku}
                {k.enabled ? "" : " (disabled)"}
              </span>
              <span>
                {k.paymentPath === "prepaid_credits" ? credits(k.usageUnits) : usdc(k.priceUsdc)}
                {k.paymentPath !== "prepaid_credits" && k.maxFeeUsdc !== "0" ? ` + up to ${usdc(k.maxFeeUsdc)} fees` : ""}
              </span>
            </li>
          ))}
        </ul>
      </details>
      <span className={`pill pill-${s.status === "approved" ? "ok" : "warn"}`}>{s.status}</span>
    </li>
  );
}

function Services({ q }: { q: string }) {
  const { workspace } = useOwner();
  const services = workspace.services.filter((s) => matches(q, s.service_key, s.origin, ...s.skus.map((k) => k.sku)));
  if (services.length === 0) return <p className="muted">{q ? "No services match." : "No services are approved for this workspace yet."}</p>;
  return (
    <ul className="market-list">
      {services.map((s) => (
        <ServiceRow key={s.id} s={s} />
      ))}
    </ul>
  );
}

export function MarketBrowser() {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const roles = ROLES.filter((r) => matches(q, ROLE_LABEL[r], TAGLINE[r], ROLE_TEMPLATES[r].description));
  return (
    <>
      <div className="page-head">
        <h1>Catalog</h1>
      </div>
      <div className="filter-row" role="group" aria-label="Show">
        {(
          [
            ["all", "All"],
            ["agents", "Agents"],
            ["services", "Services"],
          ] as Array<[Filter, string]>
        ).map(([k, label]) => (
          <button key={k} type="button" className="chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
      </div>
      <label className="market-search">
        <Icon name="search" size={18} />
        <span className="sr-only">Search agents and services</span>
        <input type="search" placeholder="Search agents and services" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>

      {filter === "all" && q === "" ? (
        <section className="market-section" aria-labelledby="m-featured">
          <h2 id="m-featured">Featured</h2>
          <div className="featured-grid">
            {ROLES.map((r) => (
              <FeaturedRole key={r} role={r} />
            ))}
          </div>
        </section>
      ) : null}

      {filter !== "services" ? (
        <section className="market-section" aria-labelledby="m-agents">
          <div className="market-section-head">
            <h2 id="m-agents">Agents</h2>
            <span className="muted small">New agents can't spend until you turn them on.</span>
          </div>
          {roles.length > 0 ? (
            <ul className="market-list">
              {roles.map((r) => (
                <RoleRow key={r} role={r} />
              ))}
            </ul>
          ) : (
            <p className="muted">No agents match.</p>
          )}
        </section>
      ) : null}

      {filter !== "agents" ? (
        <section className="market-section" aria-labelledby="m-services">
          <div className="market-section-head">
            <h2 id="m-services">Services</h2>
            <span className="muted small">What your agents can buy, and the price.</span>
          </div>
          <Services q={q} />
        </section>
      ) : null}
    </>
  );
}
