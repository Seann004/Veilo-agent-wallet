import type { ReactNode } from "react";
import { OwnerProvider } from "../components/Shell";
import type { Access, AccessRole } from "../lib/access";
import type { Workspace } from "../lib/types";
import { workspace } from "./fixtures";

export const GUEST_ADDRESS = "Guest111111111111111111111111111111111111111";

export function accessFor(role: AccessRole, ws: Workspace = workspace()): Access {
  return { role, address: role === "owner" ? ws.workspace.ownerPubkey : role === "guest" ? GUEST_ADDRESS : null };
}

/** Wraps a component in the shell context for one role (owner by default). */
export function withRole(node: ReactNode, role: AccessRole = "owner", ws: Workspace = workspace()) {
  return (
    <OwnerProvider value={{ workspace: ws, reloadWorkspace: async () => undefined, connected: null, setConnected: () => undefined, access: accessFor(role, ws) }}>
      {node}
    </OwnerProvider>
  );
}
