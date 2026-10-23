"use client";

/**
 * The latest change the page's stream heard for `path` (KOBE-496), while this tab shows it: the
 * tab joins the stream's path set on mount and leaves it on unmount. `overflow`: the tab is past
 * the stream's path limit and gets no live changes (only checks on focus).
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { WorkspaceFileChange } from "@kobe/protocol";
import type { WorkspaceChangeFeed } from "../../lib/files/remote-changes";

export interface RemoteChange {
  readonly change: WorkspaceFileChange | undefined;
  readonly overflow: boolean;
}

export function useRemoteChange(feed: WorkspaceChangeFeed | undefined, path: string): RemoteChange {
  useEffect(() => feed?.watch(path), [feed, path]);
  const subscribe = useCallback(
    (listener: () => void) => feed?.subscribe(listener) ?? (() => {}),
    [feed],
  );
  const change = useSyncExternalStore(
    subscribe,
    () => feed?.get(path),
    () => feed?.get(path),
  );
  const overflow = useSyncExternalStore(
    subscribe,
    () => feed?.overflow(path) ?? false,
    () => false,
  );
  return { change, overflow };
}
