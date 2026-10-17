import { api } from "../api";

export interface ControllerRegistration {
  controllerKey: string;
  keyId: string;
  proof: string;
}

/**
 * Control-service path that returns the controller's signed registration proof.
 *
 * PLACEHOLDER: the local control route is still being built. This path and request body are
 * assumptions; when the route lands, update them here and the matching entry in
 * lib/server/proxy.ts ROUTES. Nothing else in the dashboard depends on the route's shape.
 */
export const CONTROLLER_REGISTRATION_PATH = "/marketplace/controller/registration";

/**
 * Asks the local controller (through the owner's same-origin control session) to sign the
 * registration message for this marketplace workspace and user. The controller's private key
 * never leaves the control service; only its public key, key id and proof are returned.
 */
export async function requestControllerRegistration(workspaceId: string, userId: string): Promise<ControllerRegistration> {
  const r = await api<Partial<ControllerRegistration>>("control", CONTROLLER_REGISTRATION_PATH, { method: "POST", body: { workspaceId, userId } });
  if (typeof r.controllerKey !== "string" || typeof r.keyId !== "string" || typeof r.proof !== "string") {
    throw new Error("the local controller returned an incomplete registration");
  }
  return { controllerKey: r.controllerKey, keyId: r.keyId, proof: r.proof };
}
