"use client";

import Link from "next/link";
import { when } from "../../lib/format";
import { localControllerStatus, requestControllerRegistration } from "../../lib/market/controller-registration";
import { useAction, useResource } from "../hooks";
import { ErrorNotice, KV, Section } from "../ui";
import { useMarket } from "./MarketContext";
import { FullValue } from "./parts";

/**
 * Links the owner's local controller (spending authority) to this marketplace workspace. The
 * proof is produced by the local control service; the marketplace only records its public key.
 */
export function ControllerPanel() {
  const m = useMarket();
  const action = useAction();
  const ws = m.me?.workspace ?? null;
  const linked = Boolean(ws?.controller_key_id);
  const local = useResource(localControllerStatus, "local-controller");
  const ownerSignedOut = action.error?.status === 401 || local.error?.status === 401;
  const l = local.data;
  const localMatches = l?.configured === true && l.registration?.cloudWorkspaceId === ws?.id && l.controllerKey === ws?.controller_key;
  return (
    <Section title="Local controller" actions={<span className={linked ? "pill pill-ok" : "pill pill-warn"}>{linked ? "Linked" : "Not linked"}</span>}>
      <p className="small">
        Your local controller is the only thing that can authorize payments. Linking it lets it receive your approved hires and agent proposals from
        this marketplace workspace. Linking grants the marketplace no spending authority: the controller decides every payment locally, and automatic
        spending pauses while it is offline.
      </p>
      {ws ? (
        <KV
          rows={[
            ["Marketplace workspace", <FullValue key="w" value={ws.id} />],
            ["Controller key id", ws.controller_key_id ?? "—"],
            ["Controller public key", <FullValue key="k" value={ws.controller_key} />],
            ["Linked", when(ws.controller_registered_at)],
            ["Last seen", when(ws.controller_last_seen_at)],
          ]}
        />
      ) : (
        <p className="muted">No marketplace workspace yet; it is created when you sign in.</p>
      )}
      <h3>This computer&apos;s local controller</h3>
      {local.loading && !l ? (
        <p role="status" className="muted">
          Checking the local controller…
        </p>
      ) : l?.configured === false ? (
        <p className="notice notice-warn small">The local control service is running without a marketplace connection (MARKETPLACE_URL is not set).</p>
      ) : l?.configured ? (
        <>
          <KV
            rows={[
              ["Key id", l.keyId],
              ["Public key", <FullValue key="k" value={l.controllerKey} />],
              ["Marketplace", <FullValue key="u" value={l.marketplaceUrl} />],
              ["Registered for workspace", <FullValue key="r" value={l.registration?.cloudWorkspaceId ?? "not registered"} />],
            ]}
          />
          {linked && !localMatches ? (
            <p className="notice notice-warn small" role="status">
              The controller linked to this marketplace workspace is not this computer&apos;s controller. Re-link to use this one.
            </p>
          ) : null}
        </>
      ) : local.error && local.error.status !== 401 ? (
        <ErrorNotice error={local.error} what="local controller status" onRetry={local.reload} />
      ) : null}
      <p className="small">This step uses both sign-ins: your local owner session asks the controller for a signed proof, and your marketplace session submits it.</p>
      <div className="actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!m.canAct || action.busy || !ws || !m.me}
          onClick={() =>
            void action.run(async () => {
              if (!ws || !m.me) return;
              const reg = await requestControllerRegistration(ws.id, m.me.userId);
              await m.call("/me/controller", { method: "POST", body: reg });
              await m.reloadMe();
              await local.reload();
            })
          }
        >
          {linked ? "Re-link local controller" : "Link local controller"}
        </button>
      </div>
      {ownerSignedOut ? (
        <p className="notice notice-warn" role="status">
          Sign in to your local owner workspace first (<Link href="/">Overview</Link>), then link the controller.
        </p>
      ) : null}
      <ErrorNotice error={action.error} what="the controller could not be linked" />
    </Section>
  );
}
