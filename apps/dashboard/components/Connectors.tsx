"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { hasMarketplaceSignIn, hostOf, isActive, isNotAvailable, matchesQuery, myProposals, reviewChip, summaryOf, type Connector } from "../lib/connectors";
import { AddCustomDialog, AttachDialog, ConnectorDrawer, ConnectorIcon, NotAvailableYet, attachable, useApprovedConnectors, useAttachments, usersOf, type AttachmentMap } from "./ConnectorFlows";
import { ComingSoonApps, SendResultsTo, useChannels, YourChannels } from "./Channels";
import { Icon } from "./Icon";
import { useCapability, useOwner } from "./Shell";
import { useResource } from "./hooks";
import { DeniedHint, EmptyState, ErrorNotice, Loading } from "./ui";

type Tab = "yours" | "discover";
const TABS: Array<[Tab, string]> = [
  ["discover", "Discover"],
  ["yours", "Yours"],
];

function Tabs({ tab, onChange, ids }: { tab: Tab; onChange: (t: Tab) => void; ids: Record<Tab, { tab: string; panel: string }> }) {
  const refs = useRef<Record<Tab, HTMLButtonElement | null>>({ yours: null, discover: null });
  const onKey = (e: KeyboardEvent) => {
    const i = TABS.findIndex(([k]) => k === tab);
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next === null) return;
    e.preventDefault();
    const k = TABS[next]![0];
    onChange(k);
    refs.current[k]?.focus();
  };
  return (
    <div className="segmented" role="tablist" aria-label="Connectors" onKeyDown={onKey}>
      {TABS.map(([k, label]) => (
        <button
          key={k}
          ref={(n) => {
            refs.current[k] = n;
          }}
          type="button"
          role="tab"
          id={ids[k].tab}
          aria-selected={tab === k}
          aria-controls={ids[k].panel}
          tabIndex={tab === k ? 0 : -1}
          onClick={() => onChange(k)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function AddMenu({ disabled, reason, onCustom }: { disabled: boolean; reason: string | null; onCustom: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const items = () => [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = list.length;
      list[(i + (e.key === "ArrowDown" ? 1 : -1) + n) % n]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      (e.key === "Home" ? list[0] : list.at(-1))?.focus();
    } else if (e.key === "Tab") setOpen(false);
  };
  return (
    <div className="menu-wrap" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="btn btn-primary"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        title={reason ?? undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Icon name="plus" size={16} /> Add
      </button>
      {open ? (
        <div className="menu" role="menu" id={menuId} aria-label="Add a connector" onKeyDown={onKey}>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            tabIndex={-1}
            onClick={() => {
              close();
              onCustom();
            }}
          >
            <Icon name="plug" size={16} />
            <span>
              Custom MCP server
              <span className="menu-hint">Paste a URL to add to your workspace</span>
            </span>
          </button>
          <button type="button" role="menuitem" className="menu-item" tabIndex={-1} aria-disabled="true" onClick={(e) => e.preventDefault()}>
            <Icon name="privacy" size={16} />
            <span>
              Connector with a key or account
              <span className="menu-hint">Not supported yet</span>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ConnectorCard({ connector, used, canEdit, onOpen, onAttach }: { connector: Connector; used: number | null; canEdit: boolean; onOpen: () => void; onAttach: () => void }) {
  const summary = summaryOf(connector);
  const host = hostOf(connector.endpoint);
  return (
    <li className="connector-card">
      <div className="connector-card-top">
        <ConnectorIcon connector={connector} />
        <span className="pill pill-ok">Read-only</span>
      </div>
      <h3 className="connector-card-title">
        <button type="button" className="connector-open" onClick={onOpen} title={connector.title || connector.id}>
          {connector.title || connector.id}
        </button>
      </h3>
      <p className="connector-summary small" title={summary}>
        {summary || "No description."}
      </p>
      <p className="connector-meta small muted">
        <span className="connector-host" title={host}>
          {host}
        </span>
        <span aria-hidden="true"> · </span>
        <span>
          {connector.tools.length} tool{connector.tools.length === 1 ? "" : "s"}
        </span>
      </p>
      <div className="connector-card-foot">
        {used !== null && used > 0 ? (
          <span className="small connector-used">
            <Icon name="check" size={14} /> Used by {used} agent{used === 1 ? "" : "s"}
          </span>
        ) : (
          <span />
        )}
        <button type="button" className="btn btn-small connector-action" disabled={!canEdit} onClick={onAttach}>
          Add to agent
        </button>
      </div>
    </li>
  );
}

function Discover({ connectors, query, map, canEdit, onOpen, onAttach }: { connectors: ReturnType<typeof useApprovedConnectors>; query: string; map: AttachmentMap | undefined; canEdit: boolean; onOpen: (c: Connector) => void; onAttach: (c: Connector) => void }) {
  return (
    <section className="connector-section" aria-labelledby="agent-tools">
      <h2 id="agent-tools" className="section-title">
        Tools your agents can use
      </h2>
      <p className="small muted">Read-only. No key needed.</p>
      <ApprovedTools connectors={connectors} query={query} map={map} canEdit={canEdit} onOpen={onOpen} onAttach={onAttach} />
    </section>
  );
}

function ApprovedTools({ connectors, query, map, canEdit, onOpen, onAttach }: { connectors: ReturnType<typeof useApprovedConnectors>; query: string; map: AttachmentMap | undefined; canEdit: boolean; onOpen: (c: Connector) => void; onAttach: (c: Connector) => void }) {
  const { workspace } = useOwner();
  if (connectors.loading && !connectors.data) return <Loading label="connectors" />;
  if (connectors.error && !connectors.data) return <ErrorNotice error={connectors.error} what="connectors could not be loaded" onRetry={connectors.reload} />;
  const all = connectors.data ?? [];
  if (all.length === 0) return <EmptyState>No connectors yet. Add one with Add → Custom MCP server.</EmptyState>;
  const shown = all.filter((c) => matchesQuery(c, query));
  if (shown.length === 0) return <EmptyState>No connectors match “{query.trim()}”.</EmptyState>;
  return (
    <ul className="connector-grid" aria-label="Approved connectors">
      {shown.map((c) => (
        <ConnectorCard
          key={c.id}
          connector={c}
          used={map && map !== "unavailable" ? usersOf(c.id, workspace.agents, map).filter((u) => isActive(u.attachment)).length : null}
          canEdit={canEdit}
          onOpen={() => onOpen(c)}
          onAttach={() => onAttach(c)}
        />
      ))}
    </ul>
  );
}

function Proposals({ query }: { query: string }) {
  const signIn = hasMarketplaceSignIn();
  const res = useResource(() => (signIn ? myProposals() : Promise.resolve([])), `my-proposals-${signIn}`);
  if (!signIn) return <p className="small muted">Your proposals appear here once marketplace sign-in is part of this dashboard. It isn&apos;t yet, so none can be listed.</p>;
  if (res.loading && !res.data) return <Loading label="your proposals" />;
  if (res.error) return isNotAvailable(res.error) ? <NotAvailableYet what="Listing your proposals" /> : <ErrorNotice error={res.error} what="your proposals could not be loaded" onRetry={res.reload} />;
  const shown = (res.data ?? []).filter((p) => matchesQuery(p, query));
  if ((res.data ?? []).length === 0) return <p className="small muted">You haven&apos;t proposed a connector yet.</p>;
  if (shown.length === 0) return <p className="small muted">No proposals match “{query.trim()}”.</p>;
  return (
    <ul className="connector-rows">
      {shown.map((p) => (
        <li key={p.id} className="connector-row">
          <ConnectorIcon connector={p} size={36} />
          <span className="connector-row-text">
            <strong className="inline-text">{p.title || p.id}</strong>
            <span className="small muted">
              {hostOf(p.endpoint)} · {p.tools.length} tool{p.tools.length === 1 ? "" : "s"}
            </span>
            {p.reviewNote ? (
              <span className="small plain-text">
                Operator note: <span className="inline-text">{p.reviewNote}</span>
              </span>
            ) : null}
          </span>
          <span className={reviewChip(p.reviewStatus).className}>{reviewChip(p.reviewStatus).label}</span>
        </li>
      ))}
    </ul>
  );
}

function Yours({ connectors, map, mapError, mapLoading, reloadMap, isOwner, query, onOpen }: {
  connectors: Connector[];
  map: AttachmentMap | undefined;
  mapError: ReturnType<typeof useAttachments>["error"];
  mapLoading: boolean;
  reloadMap: () => Promise<void>;
  isOwner: boolean;
  query: string;
  onOpen: (c: Connector) => void;
}) {
  const { workspace } = useOwner();
  let attached;
  if (!isOwner) attached = <p className="small muted">Sign in as the owner to see the connectors your agents use.</p>;
  else if (mapError) attached = isNotAvailable(mapError) ? <NotAvailableYet what="Showing attached connectors" /> : <ErrorNotice error={mapError} what="attached connectors could not be loaded" onRetry={reloadMap} />;
  else if (mapLoading && !map) attached = <Loading label="attached connectors" />;
  else if (map === "unavailable") attached = <NotAvailableYet what="Showing attached connectors" />;
  else if (map) {
    const byId = new Map(connectors.map((c) => [c.id, c]));
    const ids = [...new Set(attachable(workspace.agents).flatMap((a) => (map.get(a.id) ?? []).map((x) => x.connectorId)))];
    const rows = ids
      .map((id) => ({ id, connector: byId.get(id), users: attachable(workspace.agents).filter((a) => map.get(a.id)?.some((x) => x.connectorId === id)), active: attachable(workspace.agents).some((a) => map.get(a.id)?.some((x) => x.connectorId === id && isActive(x))) }))
      .filter((r) => (r.connector ? matchesQuery(r.connector, query) : matchesQuery({ id: r.id, title: "", tools: [] }, query)));
    attached =
      ids.length === 0 ? (
        <p className="small muted">None of your agents uses a connector yet. Pick one in Discover.</p>
      ) : rows.length === 0 ? (
        <p className="small muted">No attached connectors match “{query.trim()}”.</p>
      ) : (
        <ul className="connector-rows">
          {rows.map((r) => (
            <li key={r.id} className="connector-row">
              <ConnectorIcon connector={r.connector ?? { id: r.id, title: "" }} size={36} />
              <span className="connector-row-text">
                {r.connector ? (
                  <button type="button" className="link-btn connector-row-open" onClick={() => onOpen(r.connector!)}>
                    {r.connector.title || r.id}
                  </button>
                ) : (
                  <strong className="mono">{r.id}</strong>
                )}
                <span className="small muted">Used by {r.users.map((a) => a.name).join(", ")}</span>
              </span>
              {!r.connector ? (
                <span className="pill pill-warn">No longer in Discover</span>
              ) : r.active ? (
                <span className="small connector-used">
                  <Icon name="check" size={14} /> Connected
                </span>
              ) : (
                <span className="pill pill-warn">Disabled</span>
              )}
            </li>
          ))}
        </ul>
      );
  }
  return (
    <>
      <section className="connector-section" aria-labelledby="yours-attached">
        <h2 id="yours-attached" className="section-title">
          Used by your agents
        </h2>
        {attached}
      </section>
      {hasMarketplaceSignIn() ? (
        <section className="connector-section" aria-labelledby="yours-proposals">
          <h2 id="yours-proposals" className="section-title">
            Marketplace submissions
          </h2>
          <Proposals query={query} />
        </section>
      ) : null}
    </>
  );
}

export function ConnectorsPage() {
  const { workspace } = useOwner();
  const edit = useCapability("connectors");
  const connectors = useApprovedConnectors();
  const attachments = useAttachments(workspace.agents, edit.allowed);
  const channels = useChannels(edit.allowed);
  const [tab, setTab] = useState<Tab>("discover");
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<Connector | null>(null);
  const [attach, setAttach] = useState<Connector | null>(null);
  const [adding, setAdding] = useState(false);
  const base = useId();
  const ids: Record<Tab, { tab: string; panel: string }> = {
    yours: { tab: `${base}-t-yours`, panel: `${base}-p-yours` },
    discover: { tab: `${base}-t-discover`, panel: `${base}-p-discover` },
  };
  const map = attachments.error ? undefined : attachments.data;
  return (
    <>
      <div className="page-head connectors-head">
        <h1>Connectors</h1>
        <AddMenu disabled={!edit.allowed} reason={edit.reason} onCustom={() => setAdding(true)} />
      </div>
      <p className="page-lede small muted">Tools your agents use, and where their results go.</p>
      <DeniedHint reason={edit.reason} />
      <div className="connector-toolbar">
        <Tabs tab={tab} onChange={setTab} ids={ids} />
        <label className="market-search connector-search">
          <Icon name="search" size={18} />
          <span className="sr-only">Search connectors</span>
          <input type="search" placeholder="Search connectors and tools" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>
      <div role="tabpanel" id={ids.discover.panel} aria-labelledby={ids.discover.tab} hidden={tab !== "discover"}>
        {tab === "discover" ? (
          <>
            <SendResultsTo channels={channels.data?.channels ?? []} canEdit={edit.allowed} onChanged={channels.reload} />
            <Discover connectors={connectors} query={query} map={map} canEdit={edit.allowed} onOpen={setDetail} onAttach={setAttach} />
            <ComingSoonApps />
          </>
        ) : null}
      </div>
      <div role="tabpanel" id={ids.yours.panel} aria-labelledby={ids.yours.tab} hidden={tab !== "yours"}>
        {tab === "yours" ? (
          <>
          <YourChannels channels={channels.data?.channels ?? []} agents={workspace.agents} canEdit={edit.allowed} onChanged={channels.reload} />
          <Yours
            connectors={connectors.data ?? []}
            map={map}
            mapError={attachments.error}
            mapLoading={attachments.loading}
            reloadMap={attachments.reload}
            isOwner={edit.allowed}
            query={query}
            onOpen={setDetail}
          />
          </>
        ) : null}
      </div>
      {detail && !attach ? (
        <ConnectorDrawer
          connector={detail}
          agents={workspace.agents}
          map={map}
          canEdit={edit.allowed}
          editReason={edit.reason}
          onAttach={() => setAttach(detail)}
          onChanged={attachments.reload}
          onClose={() => setDetail(null)}
        />
      ) : null}
      {attach ? <AttachDialog connector={attach} agents={workspace.agents} map={map} onChanged={attachments.reload} onClose={() => setAttach(null)} /> : null}
      {adding ? <AddCustomDialog onClose={() => setAdding(false)} /> : null}
    </>
  );
}
