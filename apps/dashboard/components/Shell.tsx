"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { NO_ACCESS, ROLE_TITLE, can, deniedReason, type Access, type Capability, type SessionInfo } from "../lib/access";
import { api, health as fetchHealth } from "../lib/api";
import { shortKey } from "../lib/format";
import { ROLE_LABEL, agentStateLabel } from "../lib/labels";
import type { Agent, Health, Workspace } from "../lib/types";
import { AgentAvatar } from "./Avatar";
import { ConnectScreen } from "./ConnectScreen";
import { NetworkStatus } from "./NetworkStatus";
import { Icon, type IconName } from "./Icon";
import { useResource } from "./hooks";
import { setPref, usePref, useTheme } from "../lib/prefs";
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
  /** Who is looking: the owner, an approved guest or the anonymous public viewer. */
  access: Access;
}

const OwnerContext = createContext<OwnerContextValue | null>(null);

export function useOwner(): OwnerContextValue {
  const v = useContext(OwnerContext);
  if (!v) throw new Error("useOwner must be used inside the owner shell");
  return v;
}

/** Outside the shell nothing is allowed, so a control rendered without context stays disabled. */
export function useAccess(): Access {
  return useContext(OwnerContext)?.access ?? NO_ACCESS;
}

export function useCapability(capability: Capability): { allowed: boolean; reason: string | null } {
  const access = useAccess();
  return { allowed: can(access, capability), reason: deniedReason(access, capability) };
}

/** Test and storybook helper: provides an owner context without a session round-trip. */
export function OwnerProvider({ value, children }: { value: OwnerContextValue; children: ReactNode }) {
  return <OwnerContext.Provider value={value}>{children}</OwnerContext.Provider>;
}

/** Sidebar entries; the last column lists other paths that count as the same section. */
const NAV: Array<[string, string, IconName, string[]]> = [
  ["/workspace", "Workspace", "home", []],
  ["/market", "Catalog", "store", []],
  ["/connectors", "Connectors", "plug", []],
  ["/activity", "Activity", "activity", []],
  ["/content", "Content", "content", []],
  ["/wallet", "Wallet", "wallet", ["/recovery", "/privacy"]],
];

const inSection = (pathname: string | null, href: string, also: string[]) => [href, ...also].some((h) => pathname?.startsWith(h));

/** Marketplace sections in the sidebar; each page shows its section's tabs. Browse is the default. */
const MARKET_GROUPS: Array<{ label: string; tabs: Array<[string, string]> }> = [
  { label: "Browse", tabs: [["/marketplace", "Workflows"], ["/marketplace/specialists", "Specialists"], ["/marketplace/tools", "Tools"], ["/marketplace/agents", "Agents"]] },
  { label: "Activity", tabs: [["/marketplace/runs", "Runs"], ["/marketplace/jobs", "Jobs"]] },
  { label: "Sell", tabs: [["/marketplace/seller", "Seller"], ["/marketplace/create", "Create a workflow"]] },
  { label: "Approvals", tabs: [["/marketplace/approvals", "Approvals"]] },
];

const underPath = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

function marketGroup(pathname: string | null): (typeof MARKET_GROUPS)[number] | null {
  if (!isMarketplacePath(pathname)) return null;
  return MARKET_GROUPS.find((g) => g.tabs.some(([h]) => h !== "/marketplace" && underPath(pathname!, h))) ?? MARKET_GROUPS[0]!;
}

function marketTabCurrent(pathname: string, href: string): boolean {
  if (href !== "/marketplace") return underPath(pathname, href);
  return !MARKET_GROUPS.flatMap((g) => g.tabs).some(([h]) => h !== "/marketplace" && underPath(pathname, h));
}

function MarketTabs({ pathname }: { pathname: string | null }) {
  const group = marketGroup(pathname);
  if (!group || group.tabs.length < 2) return null;
  return (
    <nav className="tabs" aria-label={`${group.label} sections`}>
      {group.tabs.map(([href, label]) => (
        <Link key={href} href={href} aria-current={marketTabCurrent(pathname!, href) ? "page" : undefined}>
          {label}
        </Link>
      ))}
    </nav>
  );
}

/** Marketplace pages carry their own sign-in and never need the local owner session to render. */
export const isMarketplacePath = (pathname: string | null): boolean => pathname === "/marketplace" || (pathname?.startsWith("/marketplace/") ?? false);


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
            <Link href={href} className="agent-item" aria-current={pathname === href ? "page" : undefined} title={a.name}>
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
  const session = useResource(() => api<SessionInfo>("control", "/session"), "session");
  const ws = useResource(() => api<Workspace>("control", "/workspace"), "workspace");
  const [connected, setConnected] = useState<ConnectedWallet | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [query, setQuery] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const sidebar = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const navWasOpen = useRef(false);
  const collapsed = usePref("veilo.sidebar") === "collapsed";
  const [theme, toggleTheme] = useTheme();
  const loaded = ws.data !== undefined && ws.error?.status !== 401;
  const sessionRole = session.data?.role;
  // Anything short of a confirmed owner or guest session gets the read-only controls.
  const access: Access = sessionRole === "owner" || sessionRole === "guest" ? { role: sessionRole, address: session.data?.address ?? null } : NO_ACCESS;
  const signedIn = access.role !== "viewer";
  const reloadAccess = async () => {
    await Promise.all([session.reload(), ws.reload()]);
  };
  useEffect(() => setNavOpen(false), [pathname]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const update = () => {
      setMobile(media.matches);
      if (!media.matches) setNavOpen(false);
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (mobile && navOpen) closeButton.current?.focus();
    else if (mobile && navWasOpen.current) menuButton.current?.focus();
    else if (!mobile && document.activeElement === closeButton.current) sidebar.current?.querySelector("a")?.focus();
    navWasOpen.current = navOpen;
  }, [mobile, navOpen]);
  const closeNavigation = () => {
    setNavOpen(false);
    menuButton.current?.focus();
  };

  const network = <NetworkStatus health={health.data} healthError={health.error} workspace={ws.data?.workspace} />;

  const market = isMarketplacePath(pathname);
  const waiting = (ws.loading && ws.data === undefined) || (session.loading && session.data === undefined);
  if (signingIn || (!market && (!loaded || !ws.data || waiting))) {
    let body: ReactNode;
    if (!signingIn && waiting) body = <Loading label="workspace" />;
    else if (!signingIn && ws.error && ws.error.status !== 401) body = <ErrorNotice error={ws.error} what="the control service could not load the workspace" onRetry={reloadAccess} />;
    else
      body = (
        <ConnectScreen
          onSignedIn={async (c) => {
            setConnected(c);
            setSigningIn(false);
            await reloadAccess();
          }}
          onCancel={loaded || market ? () => setSigningIn(false) : undefined}
        />
      );
    return (
      <div className="signin-page">
        <header className="signin-top">
          <Link href="/" className="brand">
            <span className="logo" aria-hidden="true" />
            Veilo
          </Link>
        </header>
        <main id="main" tabIndex={-1} className="signin-main">
          {body}
        </main>
        {network}
      </div>
    );
  }

  const data = loaded ? ws.data : undefined;
  const stopped = data?.workspace.stopped ?? false;
  const shell = (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <div className={collapsed ? "app collapsed" : "app"}>
        <aside ref={sidebar} id="sidebar" className={navOpen ? "sidebar open" : "sidebar"} aria-label="Workspace navigation"
          role={mobile ? "dialog" : undefined} aria-modal={mobile && navOpen ? true : undefined} inert={mobile && !navOpen}
          onKeyDown={(e) => {
            if (!mobile || !navOpen) return;
            if (e.key === "Escape") {
              e.preventDefault();
              closeNavigation();
            } else if (e.key === "Tab") {
              const targets = [...(sidebar.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), [tabindex="0"]') ?? [])]
                .filter((node) => node.getClientRects().length > 0);
              const target = e.shiftKey ? targets.at(-1) : targets[0];
              const edge = e.shiftKey ? targets[0] : targets.at(-1);
              if (document.activeElement === edge) {
                e.preventDefault();
                target?.focus();
              }
            }
          }}>
          <div className="sidebar-head">
            <Link href="/workspace" className="brand" aria-label="Veilo workspace">
              <span className="logo" aria-hidden="true" />
              <span className="brand-text">Veilo</span>
            </Link>
            <span className="sidebar-head-actions">
              <button ref={closeButton} type="button" className="icon-btn menu-btn" aria-label="Close navigation" onClick={closeNavigation}>
                <Icon name="close" />
              </button>
              {data && can(access, "create") ? (
                <Link href="/agents/new" className="icon-btn" aria-label="Create agent" title="Create agent">
                  <Icon name="plus" />
                </Link>
              ) : null}
              <button
                type="button"
                className="icon-btn collapse-btn"
                aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                aria-pressed={collapsed}
                onClick={() => setPref("veilo.sidebar", collapsed ? null : "collapsed")}
              >
                <Icon name="sidebar" />
              </button>
            </span>
          </div>
          {data ? (
            <>
              <label className="sidebar-search">
                <Icon name="search" size={16} />
                <span className="sr-only">Search agents</span>
                <input type="search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
              </label>
              <AgentList agents={data.agents} stopped={stopped} query={query} pathname={pathname} />
              <nav aria-label="Workspace" className="side-nav">
                <ul>
                  {NAV.map(([href, label, icon, also]) => (
                    <li key={href}>
                      <Link href={href} aria-current={inSection(pathname, href, also) ? "page" : undefined} title={label}>
                        <Icon name={icon} />
                        <span className="nav-label">{label}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            </>
          ) : null}
          <nav aria-label="Marketplace" className="side-nav side-nav-market">
            <p className="side-nav-heading" aria-hidden="true">
              Open marketplace
            </p>
            <ul>
              {MARKET_GROUPS.map(({ label, tabs }) => (
                <li key={label}>
                  <Link href={tabs[0]![0]} aria-current={marketGroup(pathname)?.label === label ? "page" : undefined} title={label}>
                    <Icon name="store" />
                    <span className="nav-label">{label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="sidebar-foot">
            <span className="owner-chip" aria-hidden="true">
              {(access.address ?? ROLE_TITLE[access.role]).slice(0, 1)}
            </span>
            <span className="owner-text">
              <span className="owner-name">{ROLE_TITLE[access.role]}</span>
              {access.address ? (
                <span className="mono small" title={access.address}>
                  {shortKey(access.address)}
                </span>
              ) : (
                <span className="small muted">Read-only</span>
              )}
            </span>
            <button type="button" className="icon-btn" aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} title={theme === "dark" ? "Light mode" : "Dark mode"} onClick={toggleTheme}>
              <Icon name={theme === "dark" ? "sun" : "moon"} />
            </button>
            {signedIn ? (
              <button
                type="button"
                className="btn btn-small sign-out"
                title="Sign out of owner workspace"
                onClick={async () => {
                  try {
                    await api("control", "/session/logout", { method: "POST" });
                  } finally {
                    setConnected(null);
                    await reloadAccess();
                  }
                }}
              >
                Sign out
              </button>
            ) : (
              <button type="button" className="btn btn-small sign-out" onClick={() => setSigningIn(true)}>
                Sign in
              </button>
            )}
          </div>
        </aside>
        {navOpen ? <button type="button" className="sidebar-scrim" tabIndex={-1} aria-label="Close navigation" onClick={closeNavigation} /> : null}
        <div className="app-main" inert={mobile && navOpen}>
          <header className="app-top">
            <button ref={menuButton} type="button" className="icon-btn menu-btn" aria-label="Open navigation" aria-controls="sidebar" aria-expanded={navOpen} onClick={() => setNavOpen(!navOpen)}>
              <Icon name={navOpen ? "close" : "menu"} />
            </button>
            <Link href="/workspace" className="brand top-brand">
              <span className="logo" aria-hidden="true" />
              Veilo
            </Link>
            {stopped ? (
              <span className="pill pill-danger" role="status">
                Emergency stop active
              </span>
            ) : null}
          </header>
          <main id="main" tabIndex={-1}>
            {data && access.role === "viewer" ? (
              <div className="notice notice-row access-banner" role="status">
                <span>
                  <strong>Read-only public view.</strong> Wallet details and operation identifiers are hidden. Sign in as the owner or an approved guest to do more.
                </span>
                <button type="button" className="btn btn-small btn-primary" onClick={() => setSigningIn(true)}>
                  Sign in
                </button>
              </div>
            ) : null}
            {session.error ? <ErrorNotice error={session.error} what="your session could not be confirmed; showing read-only controls" onRetry={reloadAccess} /> : null}
            <MarketTabs pathname={pathname} />
            {children}
          </main>
          {network}
        </div>
      </div>
    </>
  );
  // Marketplace pages can render before the workspace loads; owner views always get the context.
  return data ? <OwnerContext.Provider value={{ workspace: data, reloadWorkspace: ws.reload, connected, setConnected, access }}>{shell}</OwnerContext.Provider> : shell;
}
