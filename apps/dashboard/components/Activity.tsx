"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { credits, lamports, shortKey, usdc, when } from "../lib/format";
import { LEG_LABEL, LABEL_CREDITS_NO_CHARGE, legStateLabel, isSettled, purchaseLabel, reasonGuidance, skuLabel } from "../lib/labels";
import { hostOf } from "../lib/connectors";
import type { Activity, Agent, AuditEvent, PaymentStates, Purchase, Workspace } from "../lib/types";
import { useCapability } from "./Shell";
import { useAction } from "./hooks";
import { StateStrip } from "./StateStrip";
import { DeniedHint, ErrorNotice, KV, TxLink } from "./ui";

const LEGS: Array<keyof PaymentStates> = ["authorization", "funding", "merchant", "fulfilment", "recovery"];

function agentStopped(agent: Agent | undefined, workspaceStopped: boolean): boolean {
  return workspaceStopped || agent === undefined || agent.status !== "active";
}

export function ActivityDrawer({
  purchase,
  events,
  workspace,
  onClose,
  onChanged,
}: {
  purchase: Purchase;
  events: AuditEvent[];
  workspace: Workspace;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const action = useAction();
  const decide = useCapability("decide");
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !drawerRef.current) return;
      const items = [...drawerRef.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])")];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !drawerRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !drawerRef.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const agent = workspace.agents.find((a) => a.id === purchase.agentId);
  const service = workspace.services.find((s) => s.id === purchase.serviceId);
  const policyEvent = events.find((e) => e.action === "purchase.authorize" && e.details.purchaseId === purchase.id);
  // The public view omits chain attempts and operation identifiers.
  const attempts = purchase.chainAttempts ?? [];
  const sig = (leg: string) => attempts.filter((a) => a.leg === leg && a.signature).at(-1);
  const funding = sig("funding");
  const merchant = sig("merchant");
  const recovery = sig("recovery");
  const prepaid = purchase.paymentPath === "prepaid_credits";
  // Only a settled merchant leg (or a delivered prepaid call) is a payment that happened.
  const paid = prepaid ? purchase.states.fulfilment === "delivered" : purchase.states.merchant === "finalized";
  const titleId = `drawer-${purchase.id}`;
  const post = (path: string, body: unknown) =>
    void action.run(async () => {
      await api("control", `/purchases/${purchase.id}/${path}`, { method: "POST", body });
      await onChanged();
    });
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside ref={drawerRef} className="drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h2 id={titleId}>{skuLabel(purchase.sku)}</h2>
          <button ref={closeRef} type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="status-line">
          <strong>{purchaseLabel(purchase, { agentStopped: agentStopped(agent, workspace.workspace.stopped) })}</strong>
        </p>
        <KV
          rows={[
            ["Amount", prepaid ? `Prepaid AI credits (${credits(purchase.usage.amount)})` : usdc(purchase.price.amount)],
            [paid ? "Paid by" : "Agent", agent?.name ?? "unknown agent"],
            [paid ? "Paid to" : "Service", service ? hostOf(service.origin) : shortKey(purchase.serviceId)],
            ["Why", purchase.rationale ?? <span className="muted">no reason given</span>],
            ["When", when(purchase.settledAt ?? purchase.createdAt)],
            ...(prepaid ? [] : [["Transaction", <TxLink key="tx" signature={merchant?.signature} />] as [string, ReactNode]]),
          ]}
        />
        {paid && !prepaid ? <p className="small muted">Paid from your private pool. The service saw a fresh one-time wallet, not yours.</p> : null}
        <details className="disclosure tech-details">
          <summary>Technical details</summary>
        <StateStrip purchase={purchase} />
        <h3>Payment legs</h3>
        <ol className="legs">
          {LEGS.map((leg) => (
            <li key={leg} className={`leg leg-${purchase.states[leg]}`}>
              <span className="leg-name">{LEG_LABEL[leg]}</span>
              <span className="leg-state">{legStateLabel(purchase.states[leg])}</span>
            </li>
          ))}
        </ol>
        {purchase.stateReason ? <p className="small">Reason: {purchase.stateReason}</p> : null}
        <KV
          rows={[
            ["Payment path", prepaid ? `Prepaid gateway credits — ${LABEL_CREDITS_NO_CHARGE}` : "Private pool → fresh wallet → x402 (USDC)"],
            [
              "Policy result",
              policyEvent
                ? `${policyEvent.policyResult} (workspace policy v${purchase.policyVersions.workspace}, agent policy v${purchase.policyVersions.agent})`
                : `authorization ${purchase.states.authorization} (workspace policy v${purchase.policyVersions.workspace}, agent policy v${purchase.policyVersions.agent})`,
            ],
            ["Merchant", service ? `${service.service_key} · ${service.origin}${service.recipient ? ` · recipient ${shortKey(service.recipient)}` : ""}` : shortKey(purchase.serviceId)],
            ["Fee cap (token fees)", usdc(purchase.feeCap.amount)],
            ["Sponsor reservation (SOL)", lamports(purchase.sponsorReservation.amount)],
            ["Reservation", `${purchase.reservation.status}${purchase.reservation.closeReason ? ` (${purchase.reservation.closeReason})` : ""}`],
            ["Funding signature", prepaid ? "not applicable" : <TxLink key="f" signature={funding?.signature} />],
            ["Settlement signature", prepaid ? "not applicable" : <TxLink key="m" signature={merchant?.signature} />],
            ["Recovery signature", <TxLink key="r" signature={recovery?.signature} />],
            ...(purchase.operationId ? [["Operation ID", <span key="o" className="mono">{purchase.operationId}</span>] as [string, ReactNode]] : []),
            ["Created", when(purchase.createdAt)],
            ["Settled", when(purchase.settledAt)],
          ]}
        />
        {attempts.length > 0 ? (
          <>
            <h3>Chain attempts</h3>
            <ul className="plain small">
              {attempts.map((a) => (
                <li key={`${a.leg}-${a.attempt}`}>
                  {a.leg} #{a.attempt}: {a.commitment} — <TxLink signature={a.signature} />
                </li>
              ))}
            </ul>
          </>
        ) : null}
        </details>
        <div className="actions">
          {purchase.states.authorization === "awaiting_approval" ? (
            <>
              <button
                type="button"
                className="btn btn-primary"
                disabled={action.busy || !decide.allowed}
                onClick={() => post("decision", { decision: "approve" })}
              >
                Approve purchase
              </button>
              <button
                type="button"
                className="btn"
                disabled={action.busy || !decide.allowed}
                onClick={() => post("decision", { decision: "reject" })}
              >
                Reject purchase
              </button>
            </>
          ) : null}
          {/* Re-checking only helps while the outcome is still open. */}
          {isSettled(purchase.states) ? null : (
            <button
              type="button"
              className="btn"
              disabled={action.busy || !decide.allowed}
              onClick={() => post("reconcile", {})}
            >
              Check status again
            </button>
          )}
        </div>
        <DeniedHint reason={decide.reason} />
        <ErrorNotice error={action.error} />
      </aside>
    </div>
  );
}

export function ActivityList({ activity, workspace, onChanged, limit }: { activity: Activity; workspace: Workspace; onChanged: () => void | Promise<void>; limit?: number }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const purchases = limit ? activity.purchases.slice(0, limit) : activity.purchases;
  const open = activity.purchases.find((p) => p.id === openId);
  const close = () => {
    const id = openId;
    setOpenId(null);
    if (id) triggers.current.get(id)?.focus();
  };
  if (purchases.length === 0) return <p className="muted flush">No payments yet. They appear here when an agent buys a service.</p>;
  return (
    <>
      <ul className="activity">
        {purchases.map((p) => {
          const agent = workspace.agents.find((a) => a.id === p.agentId);
          return (
            <li key={p.id}>
              <button
                type="button"
                className="activity-row"
                ref={(el) => {
                  if (el) triggers.current.set(p.id, el);
                }}
                onClick={() => setOpenId(p.id)}
                aria-haspopup="dialog"
              >
                <span className="activity-main">
                  <strong>{agent?.name ?? "agent"}</strong> · {skuLabel(p.sku)} · {p.paymentPath === "prepaid_credits" ? "prepaid AI credits" : usdc(p.price.amount)}
                </span>
                <span className="activity-label">{purchaseLabel(p, { agentStopped: agentStopped(agent, workspace.workspace.stopped) })}</span>
                <span className="muted small">{when(p.createdAt)}</span>
              </button>
              {isSettled(p.states) ? null : <StateStrip purchase={p} />}
            </li>
          );
        })}
      </ul>
      {open ? <ActivityDrawer purchase={open} events={activity.events} workspace={workspace} onClose={close} onChanged={onChanged} /> : null}
    </>
  );
}

export function ActivityTable({ activity, workspace, onChanged, limit = 8 }: { activity: Activity; workspace: Workspace; onChanged: () => void | Promise<void>; limit?: number }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const rows = [...activity.purchases].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, limit);
  const open = activity.purchases.find((p) => p.id === openId);
  const close = () => {
    const id = openId;
    setOpenId(null);
    if (id) triggers.current.get(id)?.focus();
  };
  if (rows.length === 0) return <p className="muted flush">No payments yet. They appear here when an agent buys a service.</p>;
  return (
    <>
      <div className="table-wrap">
        <table className="payments-table">
          <caption className="sr-only">Recent payments, newest first</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Agent</th>
              <th scope="col">What</th>
              <th scope="col">Amount</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const agent = workspace.agents.find((a) => a.id === p.agentId);
              return (
                <tr key={p.id}>
                  <td className="nowrap small">{when(p.createdAt)}</td>
                  <td>{agent?.name ?? "agent"}</td>
                  <td>
                    <button
                      type="button"
                      className="link-button"
                      ref={(el) => {
                        if (el) triggers.current.set(p.id, el);
                      }}
                      onClick={() => setOpenId(p.id)}
                      aria-haspopup="dialog"
                    >
                      {skuLabel(p.sku)}
                    </button>
                  </td>
                  <td className="nowrap">{p.paymentPath === "prepaid_credits" ? "prepaid AI credits" : usdc(p.price.amount)}</td>
                  <td>{purchaseLabel(p, { agentStopped: agentStopped(agent, workspace.workspace.stopped) })}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {open ? <ActivityDrawer purchase={open} events={activity.events} workspace={workspace} onClose={close} onChanged={onChanged} /> : null}
    </>
  );
}

export function EventLog({ events }: { events: AuditEvent[] }) {
  if (events.length === 0) return <p className="muted flush">No audit events yet.</p>;
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">Audit events</caption>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">What happened</th>
            <th scope="col">By</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => {
            const reason = e.reasonCode ?? (typeof e.details.reason === "string" ? e.details.reason : null);
            const guidance = reasonGuidance(e.reasonCode);
            return (
              <tr key={e.seq}>
                <td className="nowrap small">{when(e.at)}</td>
                <td>
                  {e.action.replace(/[._]/g, " ")}
                  {reason ? <span className="muted small"> · {reason}</span> : null}
                  {guidance ? <span className="hint block">{guidance}</span> : null}
                </td>
                <td className="small">{e.details.actor === "guest" ? "guest" : e.actor.type}</td>
                <td>
                  <span className={`pill pill-${e.policyResult === "allowed" ? "ok" : e.policyResult === "denied" ? "danger" : "muted"}`}>{e.policyResult.replace(/_/g, " ")}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
