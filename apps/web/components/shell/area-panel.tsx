"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { artifactAsSheet } from "../../lib/shell/layout";
import { AREAS, areaFromUrl, closeArea, type AreaId } from "../../lib/shell/areas";
import { AreaBeside } from "../me/area-beside";
import { IconAction } from "./icon-action";
import { useShellBand } from "./shell-band";
import { useModalLayer } from "./use-modal-layer";

/** The area open beside the thread (`?area=`, CE4): follows the address, Back and Forward. */
export function useAreaUrl(): AreaId | undefined {
  const [area, setArea] = useState<AreaId | undefined>(() => areaFromUrl());
  useEffect(() => {
    const follow = () => setArea(areaFromUrl());
    window.addEventListener("popstate", follow);
    return () => window.removeEventListener("popstate", follow);
  }, []);
  return area;
}

const titleId = (area: AreaId) => `kobe-area-${area}-title`;

/**
 * A My area page beside the thread (CE4, U18, KOBE-424): in the artifact column, which it takes
 * over while open (the artifact tabs stay mounted behind it), so the conversation and its composer
 * stay on screen. Under 820 px it is the column's sheet; under 768 px a full-screen sheet with
 * Back. Close (or Escape, or Back in the browser) returns to the conversation. The page itself is
 * the My area's (`components/me/area-beside.tsx`: console primitives in a `data-kobe-console`
 * root), with the team access it needs; this frame is the chat's.
 */
export function AreaPanel({
  area,
  fetchFn,
}: {
  readonly area: AreaId | undefined;
  readonly fetchFn?: typeof fetch | undefined;
}) {
  if (area === undefined) return null;
  return <OpenArea key={area} area={area} fetchFn={fetchFn} />;
}

function OpenArea({
  area,
  fetchFn,
}: {
  readonly area: AreaId;
  readonly fetchFn: typeof fetch | undefined;
}) {
  const ref = useRef<HTMLElement>(null);
  const band = useShellBand();
  const sheet = artifactAsSheet(band);
  const modal = band === "single";
  const close = closeArea;
  // Beside the thread, focus goes back to the conversation (the sheet's layer restores its own).
  const closeToThread = () => {
    close();
    if (!sheet) document.getElementById("kobe-chat-main")?.focus();
  };
  // The sheet takes focus and, full screen, makes the rest inert; focus goes back when it closes.
  useModalLayer(ref, sheet, close, { modal, escape: false });
  // Beside the thread it takes focus too, from the link or command that opened it. Once it is
  // gone, focus that was left nowhere (an opener in a menu that has closed since) goes to the
  // conversation.
  useEffect(() => {
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    return () => {
      requestAnimationFrame(() => {
        const at = document.activeElement;
        if (at === null || at === document.body) document.getElementById("kobe-chat-main")?.focus();
      });
    };
  }, []);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.stopPropagation();
    closeToThread();
  };
  const { name } = AREAS[area];
  return (
    <aside
      ref={ref}
      tabIndex={-1}
      role={modal ? "dialog" : "region"}
      aria-modal={modal || undefined}
      aria-labelledby={titleId(area)}
      data-kobe-area={area}
      onKeyDown={onKeyDown}
      className="bg-background flex min-h-96 min-w-0 flex-col border-s outline-none"
    >
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
        {sheet && <IconAction command="artifact-back" onClick={close} />}
        <h2 id={titleId(area)} className="m-0 min-w-0 flex-1 truncate px-1 text-base font-semibold">
          {name}
        </h2>
        {!sheet && (
          <IconAction command="area-close" label={`Close ${name}`} onClick={closeToThread} />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <AreaBeside area={area} fetchFn={fetchFn} />
      </div>
    </aside>
  );
}
