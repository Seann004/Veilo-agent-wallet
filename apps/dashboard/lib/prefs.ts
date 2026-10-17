"use client";

import { useSyncExternalStore } from "react";

const CHANGED = "veilo-prefs-changed";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Per-browser display preference; storage failures fall back to the default. */
export function setPref(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Private mode or blocked storage: the choice lasts for this page only.
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

export function usePref(key: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => read(key),
    () => null,
  );
}

export type Theme = "light" | "dark";

function systemTheme(): Theme {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function useTheme(): [Theme, () => void] {
  const saved = usePref("veilo.theme");
  const current: Theme = saved === "light" || saved === "dark" ? saved : systemTheme();
  const toggle = () => {
    const next: Theme = current === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    setPref("veilo.theme", next);
  };
  return [current, toggle];
}
