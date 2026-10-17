"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { api, health as fetchHealth } from "../lib/api";
import { shortKey } from "../lib/format";
import { GATEWAY_CREDIT_LABEL, OPERATOR_INFERENCE_LABEL, ROLE_LABEL, agentStateLabel } from "../lib/labels";
import type { Agent, Health, Workspace } from "../lib/types";
import { AgentAvatar } from "./Avatar";
import { ConnectScreen } from "./ConnectScreen";
import { DevnetBadge } from "./DevnetBadge";
import { Icon, type IconName } from "./Icon";
import { useResource } from "./hooks";
import { ErrorNotice, Loading } from "./ui";

export interface ConnectedWallet {
  wallet: Wallet;
  account: WalletAccount;
}

interface OwnerContextValue {
  workspace: Workspace;
  reloadWorkspace: () => Promise<void>;
  connected: ConnectedWallet | null;
  setConnected: (c: ConnectedWallet | null) => void;
}

const OwnerContext = createContext<OwnerContextValue | null>(null);

export function useOwner(): OwnerContextValue {
  const v = useContext(OwnerContext);
  if (!v) throw new Error("useOwner must be used inside the owner shell");
  return v;
}

/** Test and storybook helper: provides an owner context without a session round-trip. */
export function OwnerProvider({ value, children }: { value: OwnerContextValue; children: ReactNode }) {
  return <OwnerContext.Provider value={value}>{children}</OwnerContext.Provider>;
}

const NAV: Array<[string, string, IconName]> = [
  ["/workspace", "Workspace", "home"],
  ["/activity", "Activity", "activity"],
  ["/content", "Content", "content"],
  ["/marketplace", "Marketplace", "store"],
  ["/wallet", "Wallet", "wallet"],
  ["/recovery", "Recovery", "recovery"],
  ["/privacy", "Privacy", "privacy"],
];

function AgentList({ agents, stopped, query, pathname }: { agents: Agent[]; stopped: boolean; query: string; pathname: string | null }) {
  const q = query.trim().toLowerCase();
  const shown = agents.filter((a) => a.status !== "archived" && (!q || a.name.toLowerCase().includes(q) || ROLE_LABEL[a.role].toLowerCase().includes(q)));
  if (agents.length === 0) return <p className="sidebar-empty">No agents yet</p>;
  if (shown.length === 0) return <p className="sidebar-empty">No agent matches “{query}”</p>;
  return (
    <ul className="agent-list">
      {shown.map((a) => {
        const href = `/agents/${a.id}`;
        return (
          <li key={a.id}>
            <Link href={href} className="agent-item" aria-current={pathname === href ? "page" : undefined}>
              <AgentAvatar agent={a} size={40} />
              <span className="agent-item-text">
                <span className="agent-item-name">{a.name}</span>
                <span className="agent-item-sub">{agentStateLabel(a.status, stopped)}</span>
              </span>
              <span className={`dot dot-${a.status === "active" && !stopped ? "ok" : a.status === "paused" || a.status === "draft" ? "warn" : "off"}`} aria-hidden="true" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const health = useResource(() => fetchHealth<Health>("control"), "health");
  const ws = useResource(() => api<Workspace>("control", "/workspace"), "workspace");
  const [connected, setConnected] = useState<ConnectedWallet | null>(null);
  const [query, setQuery] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const signedIn = ws.data !== undefined && ws.error?.status !== 401;
  useEffect(() => setNavOpen(false), [pathname]);

  const badge = <DevnetBadge health={health.data} healthError={health.error} workspace={ws.data?.workspace} />;
  const inferenceLabel = (
    <span className="inference-label" role="note" title={OPERATOR_INFERENCE_LABEL}>
      {GATEWAY_CREDIT_LABEL}
    </span>
  );

  if (!signedIn || !ws.data) {
    let body: ReactNode;
    if (ws.loading && ws.data === undefined) body = <Loading label="workspace" />;
    else if (ws.error && ws.error.status !== 401) body = <ErrorNotice error={ws.error} what="the control service could not load the workspace" onRetry={ws.reload} />;
    else
      body = (
        <ConnectScreen
          onSignedIn={async (c) => {
            setConnected(c);
            await ws.reload();
          }}
        />
      );
    return (
      <div className="signin-page">
        <header className="signin-top">
          <Link href="/" className="brand">
            <span className="logo" aria-hidden="true">
              ◆
            </span>
            Veilo
          </Link>
          <span className="top-pills">
            {badge}
            {inferenceLabel}
          </span>
        </header>
        <main id="main" tabIndex={-1} className="signin-main">
          {body}
        </main>
      </div>
    );
  }

  const data = ws.data;
  const stopped = data.workspace.stopped;
  return (
    <OwnerContext.Provider value={{ workspace: data, reloadWorkspace: ws.reload, connected, setConnected }}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <div className="app">
        <aside id="sidebar" className={navOpen ? "sidebar open" : "sidebar"} aria-label="Workspace navigation">
          <div className="sidebar-head">
            <Link href="/workspace" className="brand">
              <span className="logo" aria-hidden="true">
                ◆
              </span>
              Veilo
            </Link>
            <Link href="/agents/new" className="icon-btn" aria-label="Create agent" title="Create agent">
              <Icon name="plus" />
            </Link>
          </div>
          <label className="sidebar-search">
            <Icon name="search" size={16} />
            <span className="sr-only">Search agents</span>
            <input type="search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <AgentList agents={data.agents} stopped={stopped} query={query} pathname={pathname} />
          <nav aria-label="Workspace" className="side-nav">
            <ul>
              {NAV.map(([href, label, icon]) => (
                <li key={href}>
                  <Link href={href} aria-current={pathname?.startsWith(href) ? "page" : undefined}>
                    <Icon name={icon} />
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="sidebar-foot">
            <span className="owner-chip" aria-hidden="true">
              {data.workspace.ownerPubkey.slice(0, 1)}
            </span>
            <span className="owner-text">
              <span className="owner-name">Owner</span>
              <span className="mono small" title={data.workspace.ownerPubkey}>
                {shortKey(data.workspace.ownerPubkey)}
              </span>
            </span>
            <button
              type="button"
              className="btn btn-small"
              onClick={async () => {
                try {
                  await api("control", "/session/logout", { method: "POST" });
                } finally {
                  setConnected(null);
                  await ws.reload();
                }
              }}
            >
              Sign out
            </button>
          </div>
        </aside>
        {navOpen ? <div className="sidebar-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" /> : null}
        <div className="app-main">
          <header className="app-top">
            <button type="button" className="icon-btn menu-btn" aria-label="Open navigation" aria-controls="sidebar" aria-expanded={navOpen} onClick={() => setNavOpen(!navOpen)}>
              <Icon name={navOpen ? "close" : "menu"} />
            </button>
            <Link href="/workspace" className="brand top-brand">
              <span className="logo" aria-hidden="true">
                ◆
              </span>
              Veilo
            </Link>
            {badge}
            {inferenceLabel}
            {stopped ? (
              <span className="pill pill-danger" role="status">
                Emergency stop active
              </span>
            ) : null}
          </header>
          <main id="main" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
    </OwnerContext.Provider>
  );
}
