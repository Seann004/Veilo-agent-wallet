import { api } from "../api";

export interface ControllerRegistration {
  controllerKey: string;
  keyId: string;
  proof: string;
}

export type LocalControllerStatus =
  | { configured: false }
  | {
      configured: true;
      marketplaceUrl: string;
      controllerKey: string;
      keyId: string;
      registration: { cloudWorkspaceId: string; cloudUserId: string } | null;
    };

/** What the local control service knows about its marketplace link (owner session required). */
export function localControllerStatus(): Promise<LocalControllerStatus> {
  return api<LocalControllerStatus>("control", "/marketplace/controller");
}

/**
 * Asks the local controller (through the owner's same-origin control session) to sign the
 * registration message for this marketplace workspace and user. The controller's private key
 * never leaves the control service; only its public key, key id and proof are returned.
 */
export async function requestControllerRegistration(workspaceId: string, userId: string): Promise<ControllerRegistration> {
  const r = await api<Partial<ControllerRegistration>>("control", "/marketplace/controller/registration", { method: "POST", body: { workspaceId, userId } });
  if (typeof r.controllerKey !== "string" || typeof r.keyId !== "string" || typeof r.proof !== "string") {
    throw new Error("the local controller returned an incomplete registration");
  }
  return { controllerKey: r.controllerKey, keyId: r.keyId, proof: r.proof };
}
