"use client";

import { useEffect, useRef } from "react";
import type { ThreadState } from "../../lib/chat/thread-state";
import type { Projection } from "../../lib/chat/tree";

/** Frames to wait for the hit's message to render (the branch shows on the next commit). */
const MAX_FRAMES = 20;

/**
 * Scrolls to a search hit's message once the conversation shows it (CT15): on each new
 * `state.reveal`, the message holding the entry is found by assistant-ui's `data-message-id`
 * inside this thread view's message list (`root`), never in another mounted view.
 */
export function useReveal(
  state: ThreadState,
  projection: Projection,
  root: HTMLElement | null,
): void {
  const projectionRef = useRef(projection);
  projectionRef.current = projection;
  const seq = state.reveal?.seq;
  const entryId = state.reveal?.entryId;
  useEffect(() => {
    if (entryId === undefined) return;
    let frame = 0;
    let handle = 0;
    const tryScroll = () => {
      const node = projectionRef.current.nodeOfEntry.get(entryId);
      const el =
        node === undefined
          ? null
          : (root?.querySelector(`[data-message-id="${CSS.escape(node)}"]`) ?? null);
      if (el) {
        el.scrollIntoView({ block: "center" });
        return;
      }
      frame += 1;
      if (frame < MAX_FRAMES) handle = requestAnimationFrame(tryScroll);
    };
    handle = requestAnimationFrame(tryScroll);
    return () => cancelAnimationFrame(handle);
  }, [seq, entryId, root]);
}
