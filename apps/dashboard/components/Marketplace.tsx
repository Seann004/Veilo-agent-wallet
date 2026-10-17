"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "../lib/api";
import { AVATARS, ROLE_AVATAR } from "../lib/avatar-options";
import { credits, shortKey, usdc } from "../lib/format";
import { ROLE_LABEL } from "../lib/labels";
import type { AgentRole, Workspace } from "../lib/types";
import { ROLE_TEMPLATES } from "./Policy";
import { SitePage } from "./Site";
import { useResource } from "./hooks";
import { ErrorNotice, Loading } from "./ui";

type Filter = "all" | "agents" | "services";
const ROLES: AgentRole[] = ["credit_manager", "research", "content"];
const PATH_LABEL: Record<string, string> = { private_x402: "Private pool → x402", prepaid_credits: "Prepaid credits" };

function RoleCard({ role }: { role: AgentRole }) {
  const t = ROLE_TEMPLATES[role];
  const avatar = AVATARS.find((a) => a.id === ROLE_AVATAR[role]) ?? AVATARS[0]!;
  return (
    <article className="roster-card" id={role} aria-labelledby={`role-${role}`}>
      <img className="avatar" src={avatar.src} alt="" width={56} height={56} />
      <h3 id={`role-${role}`}>{ROLE_LABEL[role]}</h3>
      <p>{t.description}</p>
      <div>
        <p className="section-title">Default limits (you can change them before activation)</p>
        <div className="price-line">
          <span className="muted">Per purchase</span>
          <span>{usdc(t.policy.maxPurchaseTestUsdc)}</span>
        </div>
        <div className="price-line">
          <span className="muted">Per task</span>
          <span>{usdc(t.policy.taskLimitTestUsdc)}</span>
        </div>
        <div className="price-line">
          <span className="muted">Rolling 24 h</span>
          <span>{usdc(t.policy.rolling24hTestUsdc)}</span>
        </div>
        {t.policy.usageAllowanceUnits !== "0" ? (
          <div className="price-line">
            <span className="muted">Credit allowance</span>
            <span>{credits(t.policy.usageAllowanceUnits)}</span>
          </div>
        ) : null}
      </div>
      <div className="roster-meta">
        {t.policy.allowedPaymentPaths.map((p) => (
          <span key={p} className="pill">
            {PATH_LABEL[p] ?? p}
          </span>
        ))}
      </div>
      <Link href={`/agents/new?role=${role}`} className="btn btn-primary">
        Hire {ROLE_LABEL[role].toLowerCase()}
      </Link>
    </article>
  );
}

function Services() {
  const ws = useResource(() => api<Workspace>("control", "/workspace"), "market-workspace");
  if (ws.loading && !ws.data) return <Loading label="services" />;
  if (ws.error?.status === 401)
    return (
      <div className="feature">
        <h3>Sign in to see your services</h3>
        <p>
          Services are approved per workspace, with their prices and recipients. <Link href="/workspace">Sign in</Link> to see the ones your agents can buy.
        </p>
      </div>
    );
  if (ws.error) return <ErrorNotice error={ws.error} what="services" onRetry={ws.reload} />;
  const services = ws.data?.services ?? [];
  if (services.length === 0) return <p className="muted">No services are approved for this workspace yet.</p>;
  return (
    <div className="roster">
      {services.map((s) => (
        <article key={s.id} className="roster-card" aria-labelledby={`svc-${s.id}`}>
          <div className="card-head">
            <h3 id={`svc-${s.id}`}>{s.service_key}</h3>
            <span className={`pill pill-${s.status === "approved" ? "ok" : "warn"}`}>{s.status}</span>
          </div>
          <p className="mono">{s.origin}</p>
          <p className="small">
            Gateway {s.gateway_identity ?? "not bound"}
            {s.recipient ? ` · pays ${shortKey(s.recipient)}` : ""}
          </p>
          <div>
            {s.skus.map((k) => (
              <div key={`${k.sku}-${k.paymentPath}`} className="sku-line">
                <span>
                  <strong>{k.sku}</strong>
                  {k.enabled ? "" : " (disabled)"}
                  <span className="muted small"> · {PATH_LABEL[k.paymentPath] ?? k.paymentPath}</span>
                </span>
                <span className="sku-price">
                  {k.paymentPath === "prepaid_credits" ? credits(k.usageUnits) : usdc(k.priceUsdc)}
                  {k.paymentPath !== "prepaid_credits" && k.maxFeeUsdc !== "0" ? <span className="muted small"> + fees up to {usdc(k.maxFeeUsdc)}</span> : null}
                </span>
              </div>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}

export function Marketplace() {
  const [filter, setFilter] = useState<Filter>("all");
  return (
    <SitePage current="marketplace">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/">Home</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">Marketplace</span>
      </nav>
      <header className="market-head">
        <p className="eyebrow">Marketplace</p>
        <h1>Agents with a role, a budget and a price list</h1>
        <p className="lede">
          Hire an agent role, review its limits, then activate it. Every service an agent can buy shows its price and fee cap up front, and each purchase is checked against
          all of your limits first.
        </p>
      </header>
      <div className="filter-row" role="group" aria-label="Show">
        {(
          [
            ["all", "All"],
            ["agents", "Agent roles"],
            ["services", "Paid services"],
          ] as Array<[Filter, string]>
        ).map(([k, label]) => (
          <button key={k} type="button" className="chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
      </div>
      {filter !== "services" ? (
        <section className="site-section" aria-labelledby="m-agents">
          <h2 id="m-agents">Agent roles</h2>
          <p className="lede">Each role is a template. Hiring creates a draft agent; it cannot spend until you activate its policy.</p>
          <div className="roster">
            {ROLES.map((r) => (
              <RoleCard key={r} role={r} />
            ))}
          </div>
        </section>
      ) : null}
      {filter !== "agents" ? (
        <section className="site-section" aria-labelledby="m-services">
          <h2 id="m-services">Paid services</h2>
          <p className="lede">x402 services approved and bound for your workspace. Listings from other providers are not available yet.</p>
          <Services />
        </section>
      ) : null}
    </SitePage>
  );
}
