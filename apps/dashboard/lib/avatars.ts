"use client";

import { useSyncExternalStore } from "react";
import { AVATARS, ROLE_AVATAR, avatarById, type AvatarOption } from "./avatar-options";
import type { AgentRole } from "./types";
import { resolveAvatar } from "./avatar-customization";

export { AVATARS, ROLE_AVATAR, avatarById, type AvatarOption };

const KEY = (agentId: string) => `veilo.avatar.${agentId}`;
const CHANGED = "veilo-avatar-changed";

function read(agentId: string): string | null {
  try {
    return window.localStorage.getItem(KEY(agentId));
  } catch {
    return null;
  }
}

/** The avatar is a per-browser display preference; it is not stored by the control service. */
export function setAgentAvatar(agentId: string, avatarId: string): void {
  try {
    window.localStorage.setItem(KEY(agentId), avatarId);
  } catch {
    // Storage can be unavailable (private mode); the role default stays in use.
  }
  window.dispatchEvent(new Event(CHANGED));
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(CHANGED, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(CHANGED, cb);
    window.removeEventListener("storage", cb);
  };
}

export function useAgentAvatar(agentId: string, role: AgentRole): AvatarOption {
  const chosen = useSyncExternalStore(
    subscribe,
    () => read(agentId),
    () => null,
  );
  return resolveAvatar(chosen ?? ROLE_AVATAR[role]);
}
