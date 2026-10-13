import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, errorMessage, get } from "./api";

export interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** HTTP status of the failure, if any (403 = the server refused: show "no access", not a generic error) */
  status: number | null;
  reload: () => Promise<void>;
  setData: (t: T | null) => void;
}

/** GET a path and keep the result in state. Pass `null` to skip (e.g. until a filter is chosen). */
export function useApi<T>(path: string | null): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (path === null) {
      setLoading(false);
      return;
    }
    const mine = ++seq.current;
    setLoading(true);
    try {
      const d = await get<T>(path);
      if (mine === seq.current) {
        setData(d);
        setError(null);
        setStatus(null);
      }
    } catch (e) {
      if (mine === seq.current) {
        setError(errorMessage(e));
        setStatus(e instanceof ApiError ? e.status : null);
      }
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, error, loading, status, reload: load, setData };
}

/** Run an action with busy/error state, for buttons and forms. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "STEP_UP_CANCELLED")) setError(errorMessage(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, clearError: () => setError(null) };
}
