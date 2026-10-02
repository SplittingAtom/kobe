"use client";

import { useCallback, useEffect, useState } from "react";
import type { ApiError, ApiResult } from "../../lib/api/client";

export type ResourceState<T> =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: ApiError }
  | { readonly status: "ready"; readonly data: T };

/**
 * Loads `load()` on mount (and on `reload()`); a late answer from an older load is dropped.
 * Inputs captured by `load` (e.g. the team id) are fixed for the component's life: the console
 * shell keys pages by team, so another team means a fresh component.
 */
export function useResource<T>(load: () => Promise<ApiResult<T>>): {
  readonly state: ResourceState<T>;
  readonly reload: () => void;
} {
  const [state, setState] = useState<ResourceState<T>>({ status: "loading" });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let current = true;
    load().then(
      (res) => {
        if (!current) return;
        setState(
          res.ok ? { status: "ready", data: res.data } : { status: "error", error: res.error },
        );
      },
      () => {
        if (current) {
          setState({
            status: "error",
            error: {
              status: 0,
              code: "client_error",
              message: "Something went wrong. Reload the page.",
            },
          });
        }
      },
    );
    return () => {
      current = false;
    };
    // `load` is a fresh closure every render on purpose: loads happen on mount and on reload().
  }, [generation]);

  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  return { state, reload };
}

export interface Mutation {
  readonly pending: boolean;
  readonly error: ApiError | null;
  readonly notice: string | null;
  /** Runs one change; true on success. Only one change runs at a time. */
  readonly run: <T>(
    change: () => Promise<ApiResult<T>>,
    onSuccess?: (data: T) => string | null | undefined,
  ) => Promise<boolean>;
  readonly clear: () => void;
}

/** Pending/error/notice state for the changes a page makes (invite, suspend, rename…). */
export function useMutation(): Mutation {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = useCallback(
    async <T>(
      change: () => Promise<ApiResult<T>>,
      onSuccess?: (data: T) => string | null | undefined,
    ): Promise<boolean> => {
      setPending(true);
      setError(null);
      setNotice(null);
      try {
        const res = await change();
        if (!res.ok) {
          setError(res.error);
          return false;
        }
        setNotice(onSuccess?.(res.data) ?? null);
        return true;
      } catch {
        setError({ status: 0, code: "client_error", message: "Something went wrong. Try again." });
        return false;
      } finally {
        setPending(false);
      }
    },
    [],
  );

  const clear = useCallback(() => {
    setError(null);
    setNotice(null);
  }, []);

  return { pending, error, notice, run, clear };
}
