"use client";

import { BRANDS, NEEDS_SIGN_IN } from "../lib/brands";
import { useState } from "react";
import { agentAttachments, attachMany, attachmentStatusText, detachConnector, isActive, isNotAvailable, type AttachOutcome, type Connector } from "../lib/connectors";
import type { Agent } from "../lib/types";
import { AttachDialog, BrandLogo, ConnectorIcon, ConnectorPicker, NotAvailableYet, useApprovedConnectors } from "./ConnectorFlows";
import { Icon } from "./Icon";
import { useCapability, useOwner } from "./Shell";
import { useAction, useResource } from "./hooks";
import { ConfirmButton, ErrorNotice, Loading, Spinner } from "./ui";

/** Connectors section on the agent page: confirmed attachments with their tools, add and remove. */
export function AgentConnectors({ agent }: { agent: Agent }) {
  const edit = useCapability("connectors");
  if (!edit.allowed) {
    return (
      <div className="panel">
        <h2 className="section-title">Connectors</h2>
        <p className="small muted flush">{edit.reason} Connectors are listed for the owner only.</p>
      </div>
    );
  }
  return <OwnerAgentConnectors agent={agent} />;
}

function OwnerAgentConnectors({ agent }: { agent: Agent }) {
  const { workspace } = useOwner();
  const res = useResource(() => agentAttachments(agent.id), `agent-connectors-${agent.id}`);
  const approved = useApprovedConnectors();
  const act = useAction();
  const [picking, setPicking] = useState(false);
  const [attaching, setAttaching] = useState<Connector | null>(null);
  const terminal = agent.status === "archived" || agent.status === "revoked";
  const byId = new Map((approved.data ?? []).map((c) => [c.id, c]));
  const attached = res.data?.kind === "ok" ? res.data.attached : [];
  const unavailable = res.data?.kind === "unavailable";
  return (
    <div className="panel">
      <div className="panel-head">
        <h2 className="section-title flush">Connectors</h2>
        {!terminal ? (
          <button type="button" className="btn btn-small" disabled={unavailable || !res.data || !approved.data} onClick={() => setPicking(true)}>
            <Icon name="plus" size={14} /> Add connector
          </button>
        ) : null}
      </div>
      {res.loading && !res.data ? <Loading label="connectors" /> : null}
      <ErrorNotice error={res.error} what="connectors could not be loaded" onRetry={res.reload} />
      {unavailable ? <NotAvailableYet what="Adding connectors to agents" /> : null}
      {res.data?.kind === "ok" && attached.length === 0 ? <p className="small muted flush">No connectors yet. Add one so {agent.name} can look things up with its read-only tools.</p> : null}
      {attached.length > 0 ? (
        <ul className="agent-connectors">
          {attached.map((a) => {
            const c = byId.get(a.connectorId);
            return (
              <li key={a.connectorId}>
                <div className="agent-connector-head">
                  <ConnectorIcon connector={c ?? { id: a.connectorId, title: "" }} size={28} />
                  <span className="agent-connector-name">
                    <strong className="inline-text" title={c?.title || a.connectorId}>
                      {c?.title || a.connectorId}
                    </strong>
                    {!c && approved.data ? <span className="pill pill-warn">No longer in Discover</span> : null}
                    {!isActive(a) ? <span className="pill pill-warn">{attachmentStatusText(a.status)}</span> : null}
                  </span>
                  <ConfirmButton
                    label={`Remove ${c?.title || a.connectorId} from ${agent.name}`}
                    display="Remove"
                    confirmLabel="Remove"
                    warning="Remove it?"
                    disabled={act.busy}
                    onConfirm={() =>
                      void act.run(async () => {
                        await detachConnector(agent.id, a.connectorId);
                        await res.reload();
                      })
                    }
                  />
                </div>
                <ul className="tool-chips" aria-label="Allowed tools">
                  {a.tools.map((t) => (
                    <li key={t} className="tool-chip mono">
                      {t}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      ) : null}
      {act.error ? isNotAvailable(act.error) ? <NotAvailableYet what="Removing connectors" /> : <ErrorNotice error={act.error} what="the connector could not be removed" /> : null}
      {approved.error && !approved.data ? <p className="small muted">Approved connectors couldn&apos;t be loaded ({approved.error.message}).</p> : null}
      {picking && approved.data ? (
        <ConnectorPicker
          connectors={approved.data}
          used={new Set(attached.map((a) => a.connectorId))}
          onClose={() => setPicking(false)}
          onPick={(c) => {
            setPicking(false);
            setAttaching(c);
          }}
        />
      ) : null}
      {attaching ? (
        <AttachDialog
          connector={attaching}
          agents={workspace.agents}
          map={new Map([[agent.id, attached]])}
          fixedAgentId={agent.id}
          onChanged={res.reload}
          onClose={() => setAttaching(null)}
        />
      ) : null}
    </div>
  );
}

/** Optional create-agent step: pick approved connectors to attach right after the agent exists. */
export function CreateConnectorsStep({ picked, onChange, readOnly }: { picked: Connector[]; onChange: (next: Connector[]) => void; readOnly?: boolean }) {
  if (readOnly) {
    return (
      <div className="review-connectors">
        <h3 className="section-title">Connectors</h3>
        <p className="small flush">
          {picked.length === 0 ? "None. You can add connectors later on the agent page." : `Adds ${picked.map((c) => c.title || c.id).join(", ")} with all of their tools after the agent is created.`}
        </p>
      </div>
    );
  }
  return <ConnectorChoices picked={picked} onChange={onChange} />;
}

function ConnectorChoices({ picked, onChange }: { picked: Connector[]; onChange: (next: Connector[]) => void }) {
  const approved = useApprovedConnectors();
  const ids = new Set(picked.map((c) => c.id));
  return (
    <section className="panel">
      <h2 className="panel-title">Connectors</h2>
      {approved.loading && !approved.data ? (
        <Loading label="connectors" />
      ) : approved.error && !approved.data ? (
        <p className="small muted flush">Connectors aren&apos;t available right now ({approved.error.message}). You can add them later on the agent page.</p>
      ) : (approved.data ?? []).length === 0 ? (
        <p className="small muted flush">No connectors are approved yet.</p>
      ) : (
        <>
          <div className="chips" role="group" aria-label="Connectors to add">
            {approved.data!.map((c) => (
              <button
                key={c.id}
                type="button"
                className="chip chip-toggle"
                aria-pressed={ids.has(c.id)}
                onClick={() => onChange(ids.has(c.id) ? picked.filter((p) => p.id !== c.id) : [...picked, c])}
              >
                {ids.has(c.id) ? <Icon name="check" size={14} /> : <ConnectorIcon connector={c} size={20} />}
                <span className="inline-text">{c.title || c.id}</span>
              </button>
            ))}
          </div>
        </>
      )}
      <div className="coming-soon-row">
        <span className="small muted">Coming soon</span>
        {NEEDS_SIGN_IN.map((a) => (
          <span key={a.id} className="soon-logo" title={`${BRANDS[a.id].name} (coming soon)`}>
            <BrandLogo brand={BRANDS[a.id]} size={26} />
          </span>
        ))}
      </div>
    </section>
  );
}

const OUTCOME_TEXT: Record<AttachOutcome["state"], string> = {
  connected: "Connected",
  unconfirmed: "Sent, not confirmed yet",
  failed: "Failed",
  unavailable: "Not available yet",
};

/** Result of attaching after creation. Partial failure is shown per connector with a retry for the failed ones. */
export function CreatedConnectors({ agent, picked, outcomes, onRetry }: { agent: Agent; picked: Connector[]; outcomes: AttachOutcome[] | null; onRetry: (failed: Connector[]) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  if (picked.length === 0) return null;
  if (!outcomes) {
    return (
      <p className="small muted" role="status">
        <Spinner /> Adding connectors…
      </p>
    );
  }
  const title = (id: string) => picked.find((c) => c.id === id)?.title || id;
  const failed = outcomes.filter((o) => o.state === "failed" || o.state === "unavailable");
  const retryable = picked.filter((c) => outcomes.some((o) => o.connectorId === c.id && o.state !== "connected"));
  return (
    <div className={failed.length > 0 ? "notice notice-warn created-connectors" : "notice created-connectors"} role="status">
      {failed.length > 0 ? (
        <p className="flush">
          <strong>
            {agent.name} was created, but {failed.length} of {outcomes.length} connector{outcomes.length === 1 ? "" : "s"} couldn&apos;t be added.
          </strong>
        </p>
      ) : null}
      <ul className="plain">
        {outcomes.map((o) => (
          <li key={o.connectorId} className="created-connector">
            {o.state === "connected" ? <Icon name="check" size={14} /> : null}
            <span className="inline-text">{title(o.connectorId)}</span>: {OUTCOME_TEXT[o.state]}
            {o.state === "failed" && o.message ? <span className="small muted"> ({o.message})</span> : null}
          </li>
        ))}
      </ul>
      {retryable.length > 0 ? (
        <button
          type="button"
          className="btn btn-small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onRetry(retryable);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Spinner /> : null}
          Retry {retryable.length === 1 ? "it" : `these ${retryable.length}`}
        </button>
      ) : null}
    </div>
  );
}

export async function attachPicked(agentId: string, picked: Connector[]): Promise<AttachOutcome[]> {
  return attachMany(
    agentId,
    picked.map((c) => ({ connectorId: c.id, tools: c.tools.map((t) => t.name) })),
  );
}
