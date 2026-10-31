"use client";

import { useEffect } from "react";
import type { AppTabSpec } from "../../lib/apps/app-tabs";
import { artifactAsSheet } from "../../lib/shell/layout";
import type { ArtifactPanelApi } from "../chat/artifact-state";
import { useShellBand } from "../shell/shell-band";
import type { ThreadApps } from "./thread-apps";

/**
 * An app a site admin placed in the artifact column (KOBE-531, spec MA3 as amended 2026-10-31):
 * once its stored result is read, its tab opens by itself and the card shows "Opened in the side
 * column", for cards arriving live and in a reopened thread alike. One tab per card, once per
 * thread on screen (a closed tab returns the frame to the card and stays closed); the newest
 * placed card's tab is the active one. The expanded app holds its card's slot as with Expand, so
 * the thread's 3 live frames hold. Under 820 px (the artifact sheet) nothing opens by itself: the
 * card keeps its Expand button. An app's own `ui/request-display-mode` never moves it.
 *
 * Returns whether the card is due to open (so its stored result is read now).
 */
export function useAutoOpenApp({
  apps,
  panel,
  cardKey,
  placement,
  spec,
  expanded,
}: {
  readonly apps: ThreadApps;
  readonly panel: ArtifactPanelApi | null;
  readonly cardKey: string;
  readonly placement: string | undefined;
  /** The tab's spec once the stored result is read; null before. */
  readonly spec: AppTabSpec | null;
  readonly expanded: boolean;
}): boolean {
  const sheet = artifactAsSheet(useShellBand());
  const { placed, take, markAutoOpened } = apps;
  const due =
    !sheet &&
    panel !== null &&
    placement === "artifacts" &&
    placed.includes(cardKey) &&
    !apps.autoOpened(cardKey);
  useEffect(() => {
    if (!due || spec === null || panel === null) return;
    markAutoOpened(spec.cardKey);
    if (expanded) return;
    take(spec.cardKey, true);
    panel.autoOpenApp(spec, placed.at(-1) === spec.cardKey);
  }, [due, spec, panel, expanded, take, markAutoOpened, placed]);
  return due;
}
