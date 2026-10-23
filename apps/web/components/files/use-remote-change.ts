"use client";

/**
 * The latest change the page's stream heard for `path` (KOBE-496), while this tab shows it: the
 * tab joins the stream's path set on mount and leaves it on unmount.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { WorkspaceFileChange } from "@kobe/protocol";
import type { WorkspaceChangeFeed } from "../../lib/files/remote-changes";

export function useRemoteChange(
  feed: WorkspaceChangeFeed | undefined,
  path: string,
): WorkspaceFileChange | undefined {
  useEffect(() => feed?.watch(path), [feed, path]);
  const subscribe = useCallback(
    (listener: () => void) => feed?.subscribe(listener) ?? (() => {}),
    [feed],
  );
  const get = () => feed?.get(path);
  return useSyncExternalStore(subscribe, get, get);
}
