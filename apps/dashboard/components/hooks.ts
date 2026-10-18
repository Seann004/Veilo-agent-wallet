"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../lib/api";

export interface Resource<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  reload: () => Promise<void>;
}

function asApiError(e: unknown): ApiError {
  return e instanceof ApiError ? e : new ApiError(0, "INTERNAL_ERROR", (e as Error)?.message ?? "unexpected error");
}

/** Refreshes live views without overlapping requests; stops when the view unmounts. */
export function usePolling(refresh: () => Promise<void>, key: string, enabled = true, intervalMs = 3000): void {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    // Browsers mark covered or background windows hidden; keep checking there, just less often.
    const next = () => (document.hidden ? intervalMs * 4 : intervalMs);
    // One loop only: a visibility change while a refresh is in flight must not start a second.
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      clearTimeout(timer);
      try {
        await latest.current();
      } catch {
        // Resource reloads surface their own errors; a failed refresh must not stop polling.
      } finally {
        inFlight = false;
        if (active) timer = setTimeout(() => { void poll(); }, next());
      }
    };
    const onVisible = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    timer = setTimeout(() => { void poll(); }, next());
    return () => { active = false; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [key, enabled, intervalMs]);
}

/** Loads backend state; keeps the last good value while reloading and reports errors as-is. */
// Last result per resource key, so moving between pages shows what was there while it refreshes.
const resourceCache = new Map<string, unknown>();

/** Drops every cached result; called when the signed-in owner changes. */
export function clearResourceCache(): void {
  resourceCache.clear();
}

export function useResource<T>(load: () => Promise<T>, key: string): Resource<T> {
  const [data, setData] = useState<T | undefined>(() => resourceCache.get(key) as T | undefined);
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(true);
  const loader = useRef(load);
  loader.current = load;
  const keyRef = useRef(key);
  keyRef.current = key;
  const reload = useCallback(async () => {
    setLoading(true);
    const k = keyRef.current;
    if (resourceCache.has(k)) setData(resourceCache.get(k) as T);
    try {
      const next = await loader.current();
      resourceCache.set(k, next);
      if (keyRef.current === k) setData(next);
      setError(undefined);
    } catch (e) {
      const err = asApiError(e);
      // A lost or changed session must not keep showing what the previous one could see.
      if (err.status === 401 || err.status === 403) {
        resourceCache.delete(k);
        if (keyRef.current === k) setData(undefined);
      }
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload, key]);
  return { data, error, loading, reload };
}

/** Runs one owner action at a time and surfaces its backend error. */
export function useAction(): { busy: boolean; error: ApiError | undefined; run: <T>(fn: () => Promise<T>) => Promise<T | undefined>; clear: () => void } {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<ApiError>();
  const run = useCallback(async <T,>(fn: () => Promise<T>) => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      return await fn();
    } catch (e) {
      setError(asApiError(e));
      return undefined;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, []);
  return { busy, error, run, clear: () => setError(undefined) };
}
