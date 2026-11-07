"use client";

import { useEffect, useSyncExternalStore } from "react";
import { itemKindOf } from "@kobe/protocol";
import { useChatSession } from "../chat/kobe-runtime";
import { ItemChipBody } from "./app-item-chips";

/** How far the ghost sits from the pointer, so the pointer stays visible. */
const OFFSET_PX = 12;
/** The app's identifier is shown, not trusted: bounded before it is drawn. */
const NAME_MAX = 512;

const text = (value: unknown): string =>
  typeof value === "string" ? value.slice(0, NAME_MAX) : "";

/**
 * The ghost chip of a pointer drag out of an app frame (KOBE-553, DRAG-CONTRACT.md): the item's
 * kind icon and identifier in the composer's chip look, fixed at the page point, never a target
 * (`pointer-events: none`) and hidden from assistive technology. Rendered once at the chat
 * shell; nothing on the server (no drag there). The kind goes through the chips' vocabulary
 * (`itemKindOf`): anything else is the generic icon. Escape is the app's to forward as
 * `drag-cancel` (the focus is in its frame while it drags); a press in the page, or Escape there
 * when the page has the focus, ends a drag whose end never arrived (a captured pointer gives the
 * page no events until it is released).
 */
export function FrameDragGhost() {
  const store = useChatSession().frameDrag;
  const drag = useSyncExternalStore(store.subscribe, store.current, () => null);
  const live = drag !== null;
  useEffect(() => {
    if (!live) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") store.cancel();
    };
    window.addEventListener("pointerdown", store.cancel, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", store.cancel, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [live, store]);
  if (drag === null) return null;
  // Fixed in place inside the chat root (no React portal: KOBE-282), so the chip styles apply.
  return (
    <div
      aria-hidden="true"
      data-kobe-frame-drag-ghost
      className="bg-background text-foreground inline-flex max-w-64 min-w-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs shadow-md"
      style={{
        position: "fixed",
        left: drag.x,
        top: drag.y,
        transform: `translate(${OFFSET_PX}px, ${OFFSET_PX}px)`,
        pointerEvents: "none",
        zIndex: 1000,
      }}
    >
      <ItemChipBody kind={itemKindOf(drag.item["kind"])} name={text(drag.item["identifier"])} />
    </div>
  );
}
