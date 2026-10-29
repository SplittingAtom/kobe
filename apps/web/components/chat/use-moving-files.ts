import { useCallback, useEffect, useRef, useState } from "react";

/** `path` is `from` or inside it. */
function under(path: string, from: string): boolean {
  return path === from || path.startsWith(`${from}/`);
}

/**
 * The workspace moves in flight (KOBE-506). The server moves the files before it answers, so the
 * change stream can say the old path is gone, and an open tab's read find nothing there, before
 * the tab follows the move. While a move is pending, and until the render that retargets its
 * tabs is on screen, a "gone" for a path under it is the move, not a deletion.
 */
export function useMovingFiles() {
  /** Each moving path, and whether its move has answered (its tabs follow on the next commit). */
  const moving = useRef<ReadonlyMap<string, boolean>>(new Map());
  const [answers, setAnswers] = useState(0);
  const begin = useCallback((from: string) => {
    moving.current = new Map(moving.current).set(from, false);
  }, []);
  const end = useCallback((from: string) => {
    const next = new Map(moving.current);
    next.delete(from);
    moving.current = next;
  }, []);
  const answered = useCallback((from: string) => {
    if (!moving.current.has(from)) return;
    moving.current = new Map(moving.current).set(from, true);
    setAnswers((n) => n + 1);
  }, []);
  // The retargeted tabs are committed: a late read of an old path can no longer close one.
  useEffect(() => {
    if (answers === 0) return;
    moving.current = new Map([...moving.current].filter(([, done]) => !done));
  }, [answers]);
  const isMoving = useCallback(
    (path: string) => [...moving.current.keys()].some((from) => under(path, from)),
    [],
  );
  return { begin, end, answered, isMoving };
}
