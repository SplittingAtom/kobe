import { useCallback, useEffect, useRef, useState } from "react";
import type { ArtifactTabs } from "../../lib/chat/artifact-tabs";
import { filePathOfTab } from "../../lib/files/preview";
import { isWithin } from "../../lib/files/tree";

/** A failed move's files, read again by their open tabs (`seq` tells one failure from the next). */
export interface MoveRecheck {
  readonly from: string;
  readonly seq: number;
}

const hasTabUnder = (tabs: ArtifactTabs, from: string) =>
  tabs.open.some((id) => {
    const path = filePathOfTab(id);
    return path !== null && isWithin(path, from);
  });

/**
 * The workspace moves in flight (KOBE-506). The server moves the files before it answers, so the
 * change stream can say the old path is gone, and an open tab's read find nothing there, before
 * the tab follows the move. Such a "gone" is the move, not a deletion: `isMoving` says so until
 * the tabs committed on screen no longer hold a file under `from` (they followed the move). A
 * failed move is forgotten and its tabs read their files again (`recheck`): a file that really is
 * gone closes as usual. Moves by the agent or another device are not known here.
 */
export function useMovingFiles(tabs: ArtifactTabs) {
  const moving = useRef<ReadonlySet<string>>(new Set());
  const committed = useRef(tabs);
  const [recheck, setRecheck] = useState<MoveRecheck | null>(null);
  const forget = (from: string) => {
    moving.current = new Set([...moving.current].filter((f) => f !== from));
  };
  const begin = useCallback((from: string) => {
    moving.current = new Set(moving.current).add(from);
  }, []);
  /** The move answered: with no tab under `from` (nothing followed it) there is nothing to wait for. */
  const answered = useCallback((from: string) => {
    if (!hasTabUnder(committed.current, from)) forget(from);
  }, []);
  const failed = useCallback((from: string) => {
    forget(from);
    setRecheck((r) => ({ from, seq: (r?.seq ?? 0) + 1 }));
  }, []);
  useEffect(() => {
    committed.current = tabs;
    moving.current = new Set([...moving.current].filter((from) => hasTabUnder(tabs, from)));
  }, [tabs]);
  const isMoving = useCallback(
    (path: string) => [...moving.current].some((from) => isWithin(path, from)),
    [],
  );
  return { begin, answered, failed, isMoving, recheck };
}
