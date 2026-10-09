"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError } from "../../lib/api/client";
import type { FileEntry, FilesApi } from "../../lib/files/api";

export interface FolderState {
  readonly entries: readonly FileEntry[];
  readonly nextCursor: string | null;
  readonly loading: boolean;
  /** The last load failed; the previous entries stay on screen. */
  readonly error: ApiError | null;
  reload(): void;
  loadMore(): void;
}

/**
 * One folder's listing. Entries of the previous load stay while a reload runs (the "last synced"
 * view while the sandbox wakes), and a different folder never shows the old one's entries.
 */
export function useFolder(api: FilesApi, path: string): FolderState {
  const [state, setState] = useState<{
    readonly path: string;
    readonly entries: readonly FileEntry[];
    readonly nextCursor: string | null;
    readonly error: ApiError | null;
    readonly loading: boolean;
  }>({ path, entries: [], nextCursor: null, error: null, loading: true });
  const [attempt, setAttempt] = useState(0);
  const cursor = useRef<string | null>(null);

  useEffect(() => {
    let current = true;
    setState((prev) => ({ ...prev, loading: true }));
    void api.list(path).then((res) => {
      if (!current) return;
      setState((prev) => {
        const keep = prev.path === path ? prev.entries : [];
        return res.ok
          ? {
              path,
              entries: res.data.entries,
              nextCursor: res.data.nextCursor ?? null,
              error: null,
              loading: false,
            }
          : { path, entries: keep, nextCursor: null, error: res.error, loading: false };
      });
    });
    return () => {
      current = false;
    };
  }, [api, path, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  cursor.current = state.nextCursor;
  const loadMore = useCallback(() => {
    const next = cursor.current;
    if (next === null) return;
    void api.list(path, next).then((res) => {
      setState((prev) =>
        prev.path !== path
          ? prev
          : res.ok
            ? {
                ...prev,
                entries: [...prev.entries, ...res.data.entries],
                nextCursor: res.data.nextCursor ?? null,
                error: null,
              }
            : { ...prev, error: res.error },
      );
    });
  }, [api, path]);

  const shown = state.path === path ? state : { ...state, entries: [], error: null };
  return {
    entries: shown.entries,
    nextCursor: shown.nextCursor,
    loading: state.loading || state.path !== path,
    error: shown.error,
    reload,
    loadMore,
  };
}
