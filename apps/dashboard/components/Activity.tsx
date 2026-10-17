"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { credits, lamports, shortKey, usdc, when } from "../lib/format";
import { LEG_LABEL, LABEL_CREDITS_NO_CHARGE, legStateLabel, purchaseLabel, reasonGuidance } from "../lib/labels";
import type { Activity, Agent, AuditEvent, PaymentStates, Purchase, Workspace } from "../lib/types";
import { useAction } from "./hooks";
import { StateStrip } from "./StateStrip";
import { ErrorNotice, KV, TxLink } from "./ui";

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
  const sig = (leg: string) => purchase.chainAttempts.filter((a) => a.leg === leg && a.signature).at(-1);
  const funding = sig("funding");
  const merchant = sig("merchant");
  const recovery = sig("recovery");
  const prepaid = purchase.paymentPath === "prepaid_credits";
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
          <h2 id={titleId}>
            {purchase.sku} · {agent?.name ?? "unknown agent"}
          </h2>
          <button ref={closeRef} type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="status-line">
          <strong>{purchaseLabel(purchase, { agentStopped: agentStopped(agent, workspace.workspace.stopped) })}</strong>
        </p>
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
            ["Payment path", prepaid ? `Prepaid gateway credits — ${LABEL_CREDITS_NO_CHARGE}` : "Private pool → fresh wallet → x402 (test-USDC)"],
            ["Rationale", purchase.rationale ?? <span className="muted">none given</span>],
            [
              "Policy result",
              policyEvent
                ? `${policyEvent.policyResult} (workspace policy v${purchase.policyVersions.workspace}, agent policy v${purchase.policyVersions.agent})`
                : `authorization ${purchase.states.authorization} (workspace policy v${purchase.policyVersions.workspace}, agent policy v${purchase.policyVersions.agent})`,
            ],
            ["Merchant", service ? `${service.service_key} · ${service.origin}${service.recipient ? ` · recipient ${shortKey(service.recipient)}` : ""}` : shortKey(purchase.serviceId)],
            ["Price", prepaid ? credits(purchase.usage.amount) : usdc(purchase.price.amount)],
            ["Fee cap (token fees)", usdc(purchase.feeCap.amount)],
            ["Sponsor reservation (SOL)", lamports(purchase.sponsorReservation.amount)],
            ["Reservation", `${purchase.reservation.status}${purchase.reservation.closeReason ? ` (${purchase.reservation.closeReason})` : ""}`],
            ["Funding signature", prepaid ? "not applicable" : <TxLink key="f" signature={funding?.signature} />],
            ["Settlement signature", prepaid ? "not applicable" : <TxLink key="m" signature={merchant?.signature} />],
            ["Recovery signature", <TxLink key="r" signature={recovery?.signature} />],
            ["Operation ID", <span key="o" className="mono">{purchase.operationId}</span>],
            ["Created", when(purchase.createdAt)],
            ["Settled", when(purchase.settledAt)],
          ]}
        />
        {purchase.chainAttempts.length > 0 ? (
          <>
            <h3>Chain attempts</h3>
            <ul className="plain small">
              {purchase.chainAttempts.map((a) => (
                <li key={`${a.leg}-${a.attempt}`}>
                  {a.leg} #{a.attempt}: {a.commitment} — <TxLink signature={a.signature} />
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <div className="actions">
          {purchase.states.authorization === "awaiting_approval" ? (
            <>
              <button
                type="button"
                className="btn btn-primary"
                disabled={action.busy}
                onClick={() => post("decision", { decision: "approve" })}
              >
                Approve purchase
              </button>
              <button
                type="button"
                className="btn"
                disabled={action.busy}
                onClick={() => post("decision", { decision: "reject" })}
              >
                Reject purchase
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="btn"
            disabled={action.busy}
            onClick={() => post("reconcile", {})}
          >
            Reconcile with chain and gateway
          </button>
        </div>
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
                  <strong>{agent?.name ?? "agent"}</strong> · {p.sku} · {p.paymentPath === "prepaid_credits" ? credits(p.usage.amount) : usdc(p.price.amount)}
                </span>
                <span className="activity-label">{purchaseLabel(p, { agentStopped: agentStopped(agent, workspace.workspace.stopped) })}</span>
                <span className="muted small">{when(p.createdAt)}</span>
              </button>
              <StateStrip purchase={p} />
            </li>
          );
        })}
      </ul>
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
                <td className="small">{e.actor.type}</td>
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
