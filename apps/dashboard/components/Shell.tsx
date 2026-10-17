"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useState, type ReactNode } from "react";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { api, health as fetchHealth } from "../lib/api";
import { GATEWAY_CREDIT_LABEL, OPERATOR_INFERENCE_LABEL } from "../lib/labels";
import type { Health, Workspace } from "../lib/types";
import { ConnectScreen } from "./ConnectScreen";
import { DevnetBadge } from "./DevnetBadge";
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

const NAV: Array<[string, string]> = [
  ["/", "Overview"],
  ["/activity", "Activity"],
  ["/content", "Content"],
  ["/wallet", "Wallet"],
  ["/recovery", "Recovery"],
  ["/privacy", "Privacy"],
];

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const health = useResource(() => fetchHealth<Health>("control"), "health");
  const ws = useResource(() => api<Workspace>("control", "/workspace"), "workspace");
  const [connected, setConnected] = useState<ConnectedWallet | null>(null);
  const signedIn = ws.data !== undefined && ws.error?.status !== 401;

  let body: ReactNode;
  if (ws.loading && ws.data === undefined) body = <Loading label="workspace" />;
  else if (ws.error?.status === 401 || ws.data === undefined) {
    body =
      ws.error && ws.error.status !== 401 ? (
        <ErrorNotice error={ws.error} what="the control service could not load the workspace" onRetry={ws.reload} />
      ) : (
        <ConnectScreen
          onSignedIn={async (c) => {
            setConnected(c);
            await ws.reload();
          }}
        />
      );
  } else {
    body = (
      <OwnerContext.Provider value={{ workspace: ws.data, reloadWorkspace: ws.reload, connected, setConnected }}>{children}</OwnerContext.Provider>
    );
  }

  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            ◆
          </span>
          <span>Veilo</span>
        </div>
        <DevnetBadge health={health.data} healthError={health.error} workspace={ws.data?.workspace} />
        {signedIn && ws.data?.workspace.stopped ? (
          <span className="pill pill-danger" role="status">
            Emergency stop active
          </span>
        ) : null}
        {signedIn ? (
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
        ) : null}
      </header>
      <p className="inference-label" role="note">
        <strong>{GATEWAY_CREDIT_LABEL}.</strong> {OPERATOR_INFERENCE_LABEL}
      </p>
      {signedIn ? (
        <nav aria-label="Workspace" className="nav">
          <ul>
            {NAV.map(([href, label]) => {
              const current = href === "/" ? pathname === "/" : pathname?.startsWith(href);
              return (
                <li key={href}>
                  <Link href={href} aria-current={current ? "page" : undefined}>
                    {label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}
      <main id="main" tabIndex={-1}>
        {body}
      </main>
    </>
  );
}
