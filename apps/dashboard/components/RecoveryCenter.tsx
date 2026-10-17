"use client";

import { useId, useState } from "react";
import { api } from "../lib/api";
import { usdc, when } from "../lib/format";
import { agentStateLabel, hasLiveAuthority } from "../lib/labels";
import type { Activity, NoteStatus, Purchase } from "../lib/types";
import { signAndSend } from "../lib/wallet";
import { AgentControls } from "./AgentControls";
import { useOwner } from "./Shell";
import { EmergencyStop } from "./StopControls";
import { ConnectWalletPrompt, useOwnerWallet } from "./WalletView";
import { useAction, useResource } from "./hooks";
import { ErrorNotice, Loading, Section, TxLink } from "./ui";

/** The owner must tick this before any public, linkable on-chain action is confirmed. */
function PrivacyAck({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: string }) {
  const id = useId();
  return (
    <div className="field inline">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id}>{children}</label>
    </div>
  );
}

export type RecoveryClass = "safe" | "pending" | "in_recovery" | "recovered" | "none";

const MERCHANT_MAY_SETTLE = new Set(["signed", "submitted", "uncertain"]);
const MERCHANT_CLOSED = new Set(["abandoned", "expired_unsettled"]);

/**
 * Classifies a purchase for the recovery center. A funded fresh wallet is safe to recover only
 * once no signed merchant payment can still settle; until then it is pending.
 */
export function classifyRecovery(p: Purchase, agentStopped: boolean): RecoveryClass {
  const s = p.states;
  if (s.recovery === "recovered") return "recovered";
  if (s.recovery === "recovery_submitted" || s.recovery === "uncertain") return "in_recovery";
  if (s.recovery === "recoverable") return "safe";
  if (s.funding === "finalized" && MERCHANT_CLOSED.has(s.merchant) && s.fulfilment !== "delivered") return "safe";
  // An unsigned merchant leg is recoverable only once the agent can no longer sign it.
  if (s.funding === "finalized" && s.merchant === "not_started") return agentStopped ? "safe" : "pending";
  if (s.funding === "finalized" && MERCHANT_MAY_SETTLE.has(s.merchant)) return "pending";
  if (["proof_released", "submitted", "uncertain"].includes(s.funding)) return "pending";
  return "none";
}

interface RecoveryView {
  recoveryId: string;
  purchaseId: string;
  state: string;
  amount: { amount: string };
  destinationOwner: string;
  signature: string | null;
  privacyWarning: string;
}

function RecoveryRow({ p, agentName, agentStopped, onChanged }: { p: Purchase; agentName: string; agentStopped: boolean; onChanged: () => void | Promise<void> }) {
  const [view, setView] = useState<RecoveryView | null>(null);
  const [ack, setAck] = useState(false);
  const action = useAction();
  const cls = classifyRecovery(p, agentStopped);
  return (
    <li className="recovery-row">
      <p>
        <strong>{agentName}</strong> · {p.sku} · {usdc(p.price.amount)} · {when(p.updatedAt)}
      </p>
      {cls === "pending" ? <p className="small muted">Not yet safe: a payment already sent may still go through. Recovery opens once the outcome is known.</p> : null}
      {cls === "safe" && !view ? (
        <button type="button" className="btn" disabled={action.busy} onClick={() => void action.run(async () => setView(await api<RecoveryView>("wallet", "/recovery/prepare", { method: "POST", body: { purchaseId: p.id } })))}>
          Prepare recovery
        </button>
      ) : null}
      {view ? (
        <div className="notice notice-warn">
          <p>
            Recover {usdc(view.amount.amount)} to the configured owner recovery account. <strong>Privacy impact:</strong> {view.privacyWarning}
          </p>
          <p className="small">State: {view.state}</p>
          {view.state === "prepared" ? (
            <>
            <PrivacyAck checked={ack} onChange={setAck}>I understand this recovery is public and links the fresh wallet to my recovery account.</PrivacyAck>
            <button
              type="button"
              className="btn btn-primary"
              disabled={action.busy || !ack}
              onClick={() =>
                void action.run(async () => {
                  setView(await api<RecoveryView>("wallet", `/recovery/${view.recoveryId}/confirm`, { method: "POST", body: {} }));
                  await onChanged();
                })
              }
            >
              Confirm public recovery
            </button>
            </>
          ) : (
            <TxLink signature={view.signature} />
          )}
        </div>
      ) : null}
      <ErrorNotice error={action.error} />
    </li>
  );
}

function PublicExit({ notes, onChanged }: { notes: NoteStatus; onChanged: () => void | Promise<void> }) {
  const { connected } = useOwnerWallet();
  const [prepared, setPrepared] = useState<{ exitId: string; transaction: string; value: { amount: string }; privacyWarning: string } | null>(null);
  const [done, setDone] = useState<{ signature: string; state: string } | null>(null);
  const [ack, setAck] = useState(false);
  const action = useAction();
  const exitable = notes.notes.filter((n) => ["indexed", "approved", "spendable"].includes(n.state) && n.value.amount !== "0");
  return (
    <>
      <p className="hint flush">
        Sends a deposit back to your wallet. Heads up: a public exit is linkable — anyone can see which deposit it was, how much, and roughly how much you spent.
      </p>
      <ConnectWalletPrompt purpose="sign the withdrawal" />
      {exitable.length === 0 ? <p className="muted flush">Nothing to withdraw yet. Deposits can be withdrawn once they&apos;re recorded.</p> : null}
      <ul className="plain">
        {exitable.map((n) => (
          <li key={n.id}>
            {n.origin === "deposit" ? "Deposit" : "Change"} · {usdc(n.value.amount)}{" "}
            <button type="button" className="btn btn-small" disabled={action.busy} onClick={() => void action.run(async () => setPrepared(await api("wallet", "/exits/prepare", { method: "POST", body: { noteId: n.id } })))}>
              Prepare public exit
            </button>
          </li>
        ))}
      </ul>
      {prepared ? (
        <div className="notice">
          <p>
            Exit of {usdc(prepared.value.amount)} prepared. {prepared.privacyWarning}
          </p>
          <PrivacyAck checked={ack} onChange={setAck}>I understand this public exit reveals the note&apos;s deposit, value and my refund address.</PrivacyAck>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!connected || !ack || action.busy || done !== null}
            onClick={() =>
              void action.run(async () => {
                if (!connected) return;
                const signature = await signAndSend(connected.wallet, connected.account, prepared.transaction);
                const r = await api<{ state: string }>("wallet", "/exits/register", { method: "POST", body: { exitId: prepared.exitId, signature } });
                setDone({ signature, state: r.state });
                await onChanged();
              })
            }
          >
            Sign exit in wallet
          </button>
        </div>
      ) : null}
      {done ? (
        <p role="status">
          Exit {done.state}: <TxLink signature={done.signature} />
        </p>
      ) : null}
      <ErrorNotice error={action.error} />
    </>
  );
}

export function RecoveryCenter() {
  const { workspace, reloadWorkspace } = useOwner();
  const activity = useResource(() => api<Activity>("control", "/activity?limit=200"), "activity");
  const notes = useResource(() => api<NoteStatus>("wallet", "/notes/status"), "notes");
  const reloadAll = async () => {
    await Promise.all([reloadWorkspace(), activity.reload(), notes.reload()]);
  };
  const purchases = activity.data?.purchases ?? [];
  const groups: Record<Exclude<RecoveryClass, "none">, Purchase[]> = { safe: [], pending: [], in_recovery: [], recovered: [] };
  const stoppedAgent = (id: string) => workspace.workspace.stopped || workspace.agents.find((a) => a.id === id)?.status !== "active";
  for (const p of purchases) {
    const c = classifyRecovery(p, stoppedAgent(p.agentId));
    if (c !== "none") groups[c].push(p);
  }
  const live = purchases.filter((p) => hasLiveAuthority(p.states));
  const name = (id: string) => workspace.agents.find((a) => a.id === id)?.name ?? "agent";
  const list = (items: Purchase[], empty: string) =>
    items.length === 0 ? (
      <p className="muted">{empty}</p>
    ) : (
      <ul className="plain">
        {items.map((p) => (
          <RecoveryRow key={p.id} p={p} agentName={name(p.agentId)} agentStopped={stoppedAgent(p.agentId)} onChanged={reloadAll} />
        ))}
      </ul>
    );

  const stuck = [...groups.safe, ...groups.pending];
  const history = [...groups.in_recovery, ...groups.recovered];
  return (
    <>
      <p className="lede page-lede">Get money back from stuck payments or take funds out of the pool. This keeps working even when everything is stopped.</p>
      <Section title="Stop spending">
        <EmergencyStop stopped={workspace.workspace.stopped} onChanged={reloadAll} />
        {workspace.agents
          .filter((a) => a.status !== "archived")
          .map((a) => (
            <div key={a.id} className="stop-agent">
              <span>
                <strong>{a.name}</strong> <span className="muted">· {agentStateLabel(a.status, workspace.workspace.stopped)}</span>
              </span>
              <AgentControls agent={a} onChanged={reloadAll} compact />
            </div>
          ))}
        {live.length > 0 ? <p className="small section-foot">{live.length} payment(s) already sent may still settle. They stay listed until they do.</p> : null}
      </Section>
      {activity.loading && !activity.data ? <Loading label="payments" /> : null}
      <ErrorNotice error={activity.error} what="activity" onRetry={activity.reload} />
      <Section title="Stuck payments">
        {stuck.length === 0 ? <p className="muted flush">Nothing to recover.</p> : null}
        {groups.safe.length > 0 ? list(groups.safe, "") : null}
        {groups.pending.length > 0 ? list(groups.pending, "") : null}
      </Section>
      {history.length > 0 ? <Section title="Recoveries">{list(history, "")}</Section> : null}
      <Section title="Withdraw from the pool">
        {notes.data ? <PublicExit notes={notes.data} onChanged={reloadAll} /> : notes.loading ? <Loading label="deposits" /> : null}
        <ErrorNotice error={notes.error} what="wallet service" onRetry={notes.reload} />
      </Section>
    </>
  );
}
