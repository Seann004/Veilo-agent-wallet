"use client";

import { useSyncExternalStore } from "react";
import { ThinkingOrb, type OrbState } from "thinking-orbs";
import { useTheme } from "../lib/prefs";

/** What the agent is doing, in the app's words; each maps to one orb animation. */
export type ThinkingKind = "working" | "searching" | "planning" | "connecting" | "composing" | "waiting";

export const ORB_STATE: Record<ThinkingKind, OrbState> = {
  working: "working",
  searching: "searching",
  planning: "solving",
  connecting: "connecting",
  composing: "composing",
  waiting: "breathing",
};

const REDUCED = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void) {
  const mq = window.matchMedia?.(REDUCED);
  mq?.addEventListener?.("change", onChange);
  return () => mq?.removeEventListener?.("change", onChange);
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia?.(REDUCED)?.matches ?? false,
    () => false,
  );
}

/**
 * Orb loading indicator for waits on an agent or AI call. Use the plain Spinner
 * for ordinary buttons. `decorative` hides it when surrounding text already
 * announces the wait.
 */
export function AgentThinking({
  state = "working",
  size = 20,
  label = "Working",
  showLabel = false,
  decorative = false,
}: {
  state?: ThinkingKind;
  size?: 20 | 64;
  label?: string;
  showLabel?: boolean;
  decorative?: boolean;
}) {
  const [theme] = useTheme();
  const reduced = usePrefersReducedMotion();
  const orb = <ThinkingOrb state={ORB_STATE[state]} size={size} theme={theme} paused={reduced} aria-hidden="true" />;
  if (decorative) return <span className="thinking-orb" aria-hidden="true">{orb}</span>;
  return (
    <span className="thinking-orb" role="status" aria-live="polite">
      {orb}
      <span className={showLabel ? "small muted" : "sr-only"}>{label}</span>
    </span>
  );
}
