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

/** Loads backend state; keeps the last good value while reloading and reports errors as-is. */
export function useResource<T>(load: () => Promise<T>, key: string): Resource<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(true);
  const loader = useRef(load);
  loader.current = load;
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await loader.current());
      setError(undefined);
    } catch (e) {
      setError(asApiError(e));
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
