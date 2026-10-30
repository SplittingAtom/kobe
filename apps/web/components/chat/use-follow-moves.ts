import { useEffect, useMemo, useRef } from "react";
import type { WorkspaceFileChange } from "@kobe/protocol";
import type { ArtifactTabs } from "../../lib/chat/artifact-tabs";
import { filePathOfTab } from "../../lib/files/preview";
import type { WorkspaceChangeFeed } from "../../lib/files/remote-changes";

/**
 * Open file tabs follow a move the change stream names (KOBE-516): whoever moved the file (this
 * tab's file browser, another tab or device, the agent's `mv` in the sandbox), the old path's
 * change says where it went (`moved_to`) and its tab is retargeted there instead of closing with
 * "no longer in your workspace". Every open file tab is followed, previews included (a text tab
 * also follows the stream for outside edits). A deletion names no new path: the tab's read finds
 * it gone and closes it as before.
 */
export function useFollowMoves(
  feed: WorkspaceChangeFeed | undefined,
  tabs: ArtifactTabs,
  follow: (from: string, to: string) => void,
): void {
  const key = useMemo(
    () =>
      tabs.open
        .map(filePathOfTab)
        .filter((p): p is string => p !== null)
        .join("\n"),
    [tabs.open],
  );
  const followRef = useRef(follow);
  followRef.current = follow;
  const handled = useRef(new WeakSet<WorkspaceFileChange>());
  useEffect(() => {
    if (!feed || key === "") return;
    const paths = key.split("\n");
    const check = () => {
      for (const path of paths) {
        const change = feed.get(path);
        if (!change || change.moved_to == null || handled.current.has(change)) continue;
        handled.current.add(change);
        followRef.current(path, change.moved_to);
      }
    };
    const stops = paths.map((path) => feed.watch(path));
    const unsubscribe = feed.subscribe(check);
    check();
    return () => {
      unsubscribe();
      for (const stop of stops) stop();
    };
  }, [feed, key]);
}
