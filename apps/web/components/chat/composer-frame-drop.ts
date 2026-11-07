"use client";

import { useEffect, useRef } from "react";
import { pointInRect, type FrameDrag, type FrameDragStore } from "../../lib/apps/frame-drag";
import { useChatSession } from "./kobe-runtime";

export interface FrameDropTarget {
  /** Whether the page point is over the drop target (read on every phase). */
  inside(x: number, y: number): boolean;
  /** The pointer came over the target (true) or left it, ended or was cancelled (false). */
  over(over: boolean): void;
  /** Released over the target. */
  drop(drag: FrameDrag): void;
}

/**
 * Follows the session's frame drag for one drop target (KOBE-553): `over` flips as the pointer
 * enters and leaves it and is cleared on end, cancel and unsubscribe; `drop` runs once when the
 * drag ends inside. Returns the unsubscribe.
 */
export function watchFrameDrop(store: FrameDragStore, target: FrameDropTarget): () => void {
  let over = false;
  const set = (next: boolean) => {
    if (next === over) return;
    over = next;
    target.over(next);
  };
  const off = store.subscribe(({ phase, drag }) => {
    const inside = target.inside(drag.x, drag.y);
    if (phase === "start" || phase === "move") {
      set(inside);
      return;
    }
    set(false);
    if (phase === "end" && inside) target.drop(drag);
  });
  return () => {
    off();
    set(false);
  };
}

/**
 * The composer panel as the target of a pointer drag out of an app frame (KOBE-553): only a
 * writable composer with its panel on screen listens; the panel's rect is read on every phase.
 */
export function useFrameDrop({
  panel,
  writable,
  over,
  drop,
}: {
  readonly panel: HTMLElement | null;
  readonly writable: boolean;
  over(over: boolean): void;
  drop(drag: FrameDrag): void;
}): void {
  const session = useChatSession();
  const latest = useRef({ over, drop });
  useEffect(() => {
    latest.current = { over, drop };
  }, [over, drop]);
  useEffect(() => {
    if (!writable || panel === null) return undefined;
    return watchFrameDrop(session.frameDrag, {
      inside: (x, y) => pointInRect(panel.getBoundingClientRect(), x, y),
      over: (next) => latest.current.over(next),
      drop: (drag) => latest.current.drop(drag),
    });
  }, [session, panel, writable]);
}
