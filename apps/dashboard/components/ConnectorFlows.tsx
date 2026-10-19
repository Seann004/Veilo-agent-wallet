"use client";

import { brandForConnector, type Brand } from "../lib/brands";
import { useEffect, useId, useRef, useState } from "react";
import { api, type ApiError } from "../lib/api";
import {
  PINNED_TOOLS_NOTE,
  attachConnector,
  attachmentStatusText,
  detachConnector,
  hostOf,
  isActive,
  isNotAvailable,
  listConnectors,
  monogram,
  shortDigest,
  workspaceAttachments,
  type Attachment,
  type Connector,
} from "../lib/connectors";
import { ROLE_LABEL } from "../lib/labels";
import type { Agent } from "../lib/types";
import { useCapability } from "./Shell";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { useAction, useResource, type Resource } from "./hooks";
import { ConfirmButton, ErrorNotice, Spinner } from "./ui";

/** Map of agent id to its API-confirmed attachments, or "unavailable" when control has no connector endpoints. */
export type AttachmentMap = Map<string, Attachment[]> | "unavailable";

export const attachable = (agents: Agent[]) => agents.filter((a) => a.status !== "archived" && a.status !== "revoked");

export function useApprovedConnectors(): Resource<Connector[]> {
  const personal = useCapability("connectors").allowed;
  return useResource(() => listConnectors(personal), `approved-connectors-${personal}`);
}

/** Loads attachments only when `enabled` (the owner); others get undefined and no request is made. */
export function useAttachments(agents: Agent[], enabled: boolean): Resource<AttachmentMap> {
  const ids = attachable(agents).map((a) => a.id);
  const key = enabled ? `attachments-${ids.join(",")}` : "attachments-off";
  const res = useResource(() => (enabled ? workspaceAttachments(ids) : Promise.resolve<AttachmentMap>(new Map())), key);
  return enabled ? res : { ...res, data: undefined };
}

/** Agents whose confirmed attachments include this connector. */
export function usersOf(connectorId: string, agents: Agent[], map: AttachmentMap | undefined): Array<{ agent: Agent; attachment: Attachment }> {
  if (!map || map === "unavailable") return [];
  return attachable(agents).flatMap((agent) => {
    const attachment = map.get(agent.id)?.find((x) => x.connectorId === connectorId);
    return attachment ? [{ agent, attachment }] : [];
  });
}

export function ConnectorIcon({ connector, size = 40 }: { connector: Pick<Connector, "title" | "id"> & { endpoint?: string }; size?: number }) {
  const brand = brandForConnector(connector);
  if (brand) return <BrandLogo brand={brand} size={size} />;
  return (
    <span className="connector-icon" style={{ width: size, height: size }} aria-hidden="true">
      {monogram(connector.title, connector.id)}
    </span>
  );
}

/** A brand's own logo on a neutral tile; the dark variant shows only in dark mode. */
export function BrandLogo({ brand, size = 40 }: { brand: Brand; size?: number }) {
  const inner = Math.round(size * 0.6);
  return (
    <span className="brand-tile" style={{ width: size, height: size }} aria-hidden="true">
      <img className={brand.logoDark ? "brand-img brand-img-light" : "brand-img"} src={brand.logo} alt="" width={inner} height={inner} />
      {brand.logoDark ? <img className="brand-img brand-img-dark" src={brand.logoDark} alt="" width={inner} height={inner} /> : null}
    </span>
  );
}

export function NotAvailableYet({ what }: { what: string }) {
  return (
    <div className="notice notice-warn" role="status">
      <strong>Not available yet.</strong> {what} needs a control service update that isn't deployed here. Nothing was changed.
    </div>
  );
}

/** A refused or failed action; a 404 from the connector endpoints is shown as not available yet. */
function ActionError({ error, what }: { error: ApiError | undefined; what: string }) {
  if (!error) return null;
  if (isNotAvailable(error)) return <NotAvailableYet what={what} />;
  return <ErrorNotice error={error} what={what.toLowerCase()} />;
}

function UsedBy({ connector, agents, map, canEdit, onChanged }: { connector: Connector; agents: Agent[]; map: AttachmentMap | undefined; canEdit: boolean; onChanged: () => Promise<void> }) {
  const act = useAction();
  if (map === undefined) return <p className="small muted">Sign in as the owner to see which agents use this connector.</p>;
  if (map === "unavailable") return <NotAvailableYet what="Showing which agents use a connector" />;
  const users = usersOf(connector.id, agents, map);
  return (
    <>
      {users.length === 0 ? (
        <p className="small muted">No agent uses this connector yet.</p>
      ) : (
        <ul className="connector-users">
          {users.map(({ agent, attachment }) => (
            <li key={agent.id}>
              <span className="connector-user">
                {isActive(attachment) ? <Icon name="check" size={16} /> : <span className="pill pill-warn">{attachmentStatusText(attachment.status)}</span>}
                <span>
                  <strong>{agent.name}</strong>
                  <span className="small muted">
                    {" "}
                    · {attachment.tools.length} of {connector.tools.length} tool{connector.tools.length === 1 ? "" : "s"}
                  </span>
                </span>
              </span>
              {canEdit ? (
                <ConfirmButton
                  label={`Remove ${connector.title || connector.id} from ${agent.name}`}
                  display="Remove"
                  confirmLabel="Remove"
                  warning={`${agent.name} stops using it.`}
                  disabled={act.busy}
                  onConfirm={() =>
                    void act.run(async () => {
                      await detachConnector(agent.id, connector.id);
                      await onChanged();
                    })
                  }
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <ActionError error={act.error} what="Removing a connector" />
    </>
  );
}

function SchemaView({ schema }: { schema: Record<string, unknown> }) {
  return (
    <details className="schema">
      <summary className="small">Input schema</summary>
      <pre className="mono schema-json">{JSON.stringify(schema, null, 2)}</pre>
    </details>
  );
}

function CopyDigest({ value }: { value: string | undefined }) {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  if (!value) return <span className="muted">—</span>;
  return (
    <span className="digest">
      <span className="mono" title={value}>
        {shortDigest(value)}
      </span>
      <button
        type="button"
        className="btn btn-small"
        aria-label="Copy manifest digest"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied("yes");
          } catch {
            setCopied("no");
          }
        }}
      >
        <Icon name="copy" size={14} />
        {copied === "yes" ? "Copied" : "Copy"}
      </button>
      {copied === "no" ? <span className="small muted">Copy failed; select the full value from the tooltip.</span> : null}
    </span>
  );
}

export function ConnectorDrawer({
  connector,
  agents,
  map,
  canEdit,
  editReason,
  onAttach,
  onChanged,
  onClose,
}: {
  connector: Connector;
  agents: Agent[];
  map: AttachmentMap | undefined;
  canEdit: boolean;
  editReason: string | null;
  onAttach: () => void;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  return (
    <Modal
      variant="drawer"
      onClose={onClose}
      title={
        <span className="connector-title">
          <ConnectorIcon connector={connector} size={32} />
          <span className="inline-text">{connector.title || connector.id}</span>
        </span>
      }
    >
      <p className="connector-badges">
        <span className="pill pill-ok">Read-only</span>
        <span className="pill pill-muted">
          {connector.tools.length} tool{connector.tools.length === 1 ? "" : "s"}
        </span>
        <span className="pill pill-muted">No key needed</span>
      </p>
      <dl className="kv">
        <div className="kv-row">
          <dt>ID</dt>
          <dd className="mono">{connector.id}</dd>
        </div>
        <div className="kv-row">
          <dt>Endpoint</dt>
          <dd className="mono wrap-anywhere">{connector.endpoint}</dd>
        </div>
        <div className="kv-row">
          <dt>Manifest digest</dt>
          <dd>
            <CopyDigest value={connector.manifest_sha256} />
          </dd>
        </div>
      </dl>
      <p className="notice notice-help small" role="note">
        {PINNED_TOOLS_NOTE}
      </p>
      <h3 className="section-title">Tools</h3>
      <ul className="tool-list">
        {connector.tools.map((t) => (
          <li key={t.name}>
            <p className="mono tool-name flush">{t.name}</p>
            <p className="small plain-text flush">{t.description || "No description."}</p>
            {t.template ? (
              <p className="small muted flush">
                Fixed Veilo query run through the server&apos;s <span className="mono">{t.template.upstream}</span> tool. Agents fill in only the inputs below, never code.
              </p>
            ) : null}
            <SchemaView schema={t.inputSchema} />
          </li>
        ))}
      </ul>
      <h3 className="section-title">Used by</h3>
      <UsedBy connector={connector} agents={agents} map={map} canEdit={canEdit} onChanged={onChanged} />
      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={!canEdit} onClick={onAttach}>
          Add to agent
        </button>
      </div>
      {editReason ? <p className="hint access-hint">{editReason}</p> : null}
    </Modal>
  );
}

/** Pick an agent, tick the allowed tools, confirm. "Connected" appears only once the API lists it. */
export function AttachDialog({
  connector,
  agents,
  map,
  fixedAgentId,
  onChanged,
  onClose,
}: {
  connector: Connector;
  agents: Agent[];
  map: AttachmentMap | undefined;
  fixedAgentId?: string;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const choices = attachable(agents);
  const users = usersOf(connector.id, agents, map);
  const firstFree = choices.find((a) => !users.some((u) => u.agent.id === a.id)) ?? choices[0];
  const [agentId, setAgentId] = useState(fixedAgentId ?? firstFree?.id ?? "");
  const existing = users.find((u) => u.agent.id === agentId)?.attachment;
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(existing ? existing.tools : connector.tools.map((t) => t.name)));
  const [sent, setSent] = useState<string | null>(null);
  const act = useAction();
  const doneRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (sent) doneRef.current?.focus();
  }, [sent]);
  const agent = choices.find((a) => a.id === agentId);
  const chooseAgent = (next: string) => {
    setAgentId(next);
    const prior = users.find((u) => u.agent.id === next)?.attachment;
    setTicked(new Set(prior ? prior.tools : connector.tools.map((t) => t.name)));
  };
  const confirmed = sent !== null && users.some((u) => u.agent.id === sent && isActive(u.attachment));
  const sentAgent = choices.find((a) => a.id === sent);
  const tools = connector.tools.map((t) => t.name).filter((n) => ticked.has(n));
  return (
    <Modal
      title={`Add ${connector.title || connector.id} to an agent`}
      onClose={onClose}
      footer={
        sent ? (
          <button ref={doneRef} type="button" className="btn" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!agent || tools.length === 0 || act.busy || map === "unavailable"}
              onClick={() =>
                void act.run(async () => {
                  await attachConnector(agentId, connector.id, tools);
                  setSent(agentId);
                  await onChanged();
                })
              }
            >
              {act.busy ? <Spinner /> : null}
              {existing ? "Update tools" : agent ? `Add to ${agent.name}` : "Add"}
            </button>
          </>
        )
      }
    >
      {map === "unavailable" ? <NotAvailableYet what="Adding connectors to agents" /> : null}
      {sent ? (
        confirmed ? (
          <p className="notice notice-ok connector-confirmed" role="status">
            <Icon name="check" size={16} /> Connected to {sentAgent?.name ?? "the agent"}. It can call the {tools.length} tool{tools.length === 1 ? "" : "s"} you ticked.
          </p>
        ) : (
          <p className="notice notice-warn" role="status">
            Sent. The control service doesn&apos;t list this connector for {sentAgent?.name ?? "the agent"} yet, so it isn&apos;t shown as connected.
          </p>
        )
      ) : (
        <>
          {fixedAgentId ? (
            <p className="small">
              Agent: <strong>{agent?.name ?? "unknown agent"}</strong>
            </p>
          ) : choices.length === 0 ? (
            <p className="muted">No agents to add it to. Create an agent first.</p>
          ) : (
            <div className="field">
              <span className="field-label" aria-hidden="true">
                Agent
              </span>
              <Select
                label="Agent"
                value={agentId}
                onChange={chooseAgent}
                options={choices.map((a) => ({
                  value: a.id,
                  label: a.name,
                  hint: `${ROLE_LABEL[a.role]}${users.some((u) => u.agent.id === a.id) ? " · already uses it" : ""}`,
                }))}
              />
            </div>
          )}
          <fieldset className="tool-ticks">
            <legend>Tools it may call</legend>
            {connector.tools.map((t) => (
              <label key={t.name} className="tool-tick">
                <input
                  type="checkbox"
                  checked={ticked.has(t.name)}
                  onChange={(e) => {
                    const next = new Set(ticked);
                    if (e.target.checked) next.add(t.name);
                    else next.delete(t.name);
                    setTicked(next);
                  }}
                />
                <span>
                  <span className="mono">{t.name}</span>
                  <span className="small muted tool-tick-desc">{t.description}</span>
                </span>
              </label>
            ))}
            {tools.length === 0 ? <p className="hint">Tick at least one tool.</p> : null}
          </fieldset>
          <p className="hint">Read-only tools. No key or account is shared. {PINNED_TOOLS_NOTE}</p>
        </>
      )}
      <ActionError error={act.error} what="Adding a connector to an agent" />
      {users.length > 0 ? (
        <>
          <h3 className="section-title">Already used by</h3>
          <UsedBy connector={connector} agents={agents} map={map} canEdit onChanged={onChanged} />
        </>
      ) : null}
    </Modal>
  );
}

/** Add a personal connection directly; it is never published to the shared marketplace. */
export function AddCustomDialog({ onClose, onSubmitted }: { onClose: () => void; onSubmitted?: () => void }) {
  const fid = useId();
  const [endpoint, setEndpoint] = useState("");
  const [title, setTitle] = useState("");
  const [done, setDone] = useState<Connector | null>(null);
  const act = useAction();
  return <Modal title="Custom MCP server" onClose={onClose} footer={done ? <button type="button" className="btn" onClick={onClose}>Done</button> : <><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="submit" form={`${fid}-custom`} className="btn btn-primary" disabled={act.busy || !endpoint.trim()}>{act.busy ? <Spinner /> : null}Add connector</button></>}>
    {done ? <div role="status"><p><strong>{done.title}</strong> added to your workspace. No operator review needed.</p><p className="small">Attach it to an agent to use its {done.tools.length} tools.</p></div> : <form id={`${fid}-custom`} onSubmit={(e) => { e.preventDefault(); void act.run(async () => { const result = await api<{ connector: Connector }>("control", "/connectors/custom", { method: "POST", body: { endpoint: endpoint.trim(), ...(title.trim() ? { title: title.trim() } : {}) } }); setDone(result.connector); onSubmitted?.(); }); }}>
      <p className="small">Paste a public MCP URL. Veilo discovers its supported tools and adds the connection to this workspace.</p>
      <div className="field"><label htmlFor={`${fid}-url`}>Endpoint (https)</label><input id={`${fid}-url`} type="url" required data-autofocus value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://mcp.api.coingecko.com/mcp" /></div>
      <div className="field"><label htmlFor={`${fid}-title`}>Name (optional)</label><input id={`${fid}-title`} maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
      <p className="hint">Keyless, read-oriented tools. Tool definitions are pinned and checked on each call.</p>
    </form>}
    <ErrorNotice error={act.error} />
  </Modal>;
}

/** Approved connectors this agent doesn't use yet; choosing one opens the attach step for it. */
export function ConnectorPicker({ connectors, used, onPick, onClose }: { connectors: Connector[]; used: Set<string>; onPick: (c: Connector) => void; onClose: () => void }) {
  const free = connectors.filter((c) => !used.has(c.id));
  return (
    <Modal title="Add connector" onClose={onClose}>
      {connectors.length === 0 ? (
        <p className="muted">No connectors are approved yet.</p>
      ) : free.length === 0 ? (
        <p className="muted">This agent already uses every approved connector.</p>
      ) : (
        <ul className="picker-list">
          {free.map((c) => (
            <li key={c.id}>
              <button type="button" className="picker-item" onClick={() => onPick(c)}>
                <ConnectorIcon connector={c} size={32} />
                <span className="picker-text">
                  <strong className="inline-text">{c.title || c.id}</strong>
                  <span className="small muted">
                    {hostOf(c.endpoint)} · {c.tools.length} tool{c.tools.length === 1 ? "" : "s"}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
