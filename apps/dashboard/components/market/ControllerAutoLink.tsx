"use client";

import { useEffect, useRef } from "react";
import { localControllerStatus, requestControllerRegistration } from "../../lib/market/controller-registration";
import { useResource } from "../hooks";
import { useMarket } from "./MarketContext";

/**
 * Links this computer's controller once both sign-ins exist and the marketplace workspace has no
 * controller yet. It never replaces a controller that is already linked (possibly another
 * computer's); that stays a deliberate re-link on Marketplace → Agents. Failures are left to that
 * panel's button, which shows the error.
 */
export function ControllerAutoLink() {
  const m = useMarket();
  const local = useResource(localControllerStatus, "local-controller");
  const tried = useRef(false);
  const ws = m.me?.workspace ?? null;
  const l = local.data;
  const ready = Boolean(ws && m.me && m.canAct && !ws.controller_key_id && l?.configured);
  useEffect(() => {
    if (!ready || tried.current || !ws || !m.me) return;
    tried.current = true;
    void (async () => {
      try {
        const reg = await requestControllerRegistration(ws.id, m.me!.userId);
        await m.call("/me/controller", { method: "POST", body: reg });
        await m.reloadMe();
        await local.reload();
      } catch {
        // The Local controller panel still offers the manual link and reports why it failed.
      }
    })();
  }, [ready, ws, m, local]);
  return null;
}
