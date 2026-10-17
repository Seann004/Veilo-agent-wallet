/**
 * What each browser role may do in the dashboard. This only decides which controls are enabled;
 * the control and wallet services enforce the same split on every request.
 */
export type AccessRole = "owner" | "guest" | "viewer";

export interface Access {
  role: AccessRole;
  /** Signed-in wallet; null for the anonymous public viewer. */
  address: string | null;
}

/** Shape of GET /session. "none" means no session and no public view. */
export interface SessionInfo {
  role: AccessRole | "none";
  address: string | null;
  expiresAt: string | null;
  publicView: boolean;
}

export type Capability = "run" | "configure" | "create" | "stop" | "fund" | "recover" | "decide" | "review" | "archive" | "connectors";

const ALLOWED: Record<Capability, readonly AccessRole[]> = {
  run: ["owner", "guest"],
  configure: ["owner"],
  create: ["owner"],
  stop: ["owner"],
  fund: ["owner"],
  recover: ["owner"],
  decide: ["owner"],
  review: ["owner"],
  archive: ["owner"],
  connectors: ["owner"],
};

/** Used when no access is known (outside the shell): nothing is allowed. */
export const NO_ACCESS: Access = { role: "viewer", address: null };

export const ROLE_TITLE: Record<AccessRole, string> = { owner: "Owner", guest: "Guest", viewer: "Public viewer" };

export function can(access: Access, capability: Capability): boolean {
  return ALLOWED[capability].includes(access.role);
}

/** Short reason shown next to a disabled control; null when the action is allowed. */
export function deniedReason(access: Access, capability: Capability): string | null {
  if (can(access, capability)) return null;
  if (access.role === "viewer") return capability === "run" ? "Sign in to run agents." : "Read-only view. Sign in as the owner to do this.";
  return "Only the workspace owner can do this.";
}
