"use client";

import { ThreadListPrimitive, useAuiState } from "@assistant-ui/react";
import { useEffect, useRef } from "react";
import type { ApiError } from "../../lib/api/client";
import type { FilesApi } from "../../lib/files/api";
import { FileBrowser } from "../files/file-browser";
import { IconAction } from "./icon-action";
import { RailDivider } from "./rail-divider";
import {
  RailDropNotice,
  RailDropOverlay,
  useRailDropZone,
  type DropStatus,
} from "./rail-drop-zone";
import { sectionRows, useRail, type RailApi } from "./rail-state";
import { useShellBand } from "./shell-band";
import { useModalLayer } from "./use-modal-layer";
import { RailThreads } from "./rail-threads";
import styles from "./rail.module.css";

const SECTION_IDS = { threads: "kobe-rail-threads", files: "kobe-rail-files" } as const;

/** The drawer closes once a thread is on screen, however it was opened (CE8). */
function useFoldOnThreadChange({ closeDrawer }: RailApi) {
  const threadId = useAuiState((s) => s.threadListItem.id);
  const seen = useRef(threadId);
  useEffect(() => {
    if (seen.current === threadId) return;
    seen.current = threadId;
    closeDrawer();
  }, [threadId, closeDrawer]);
}

/** Moves focus to the section the member asked for, once it is on screen (once per request). */
function useRevealFocus({ revealed, collapsed }: RailApi) {
  const handled = useRef(0);
  useEffect(() => {
    if (revealed === null || collapsed || handled.current === revealed.seq) return;
    handled.current = revealed.seq;
    document.getElementById(SECTION_IDS[revealed.section])?.focus();
  }, [revealed, collapsed]);
}

/**
 * The three icons of the collapsed rail (CE5). New keeps the rail as it is. Hidden, not unmounted,
 * while the rail is expanded, so focus can return to the icon that opened a drawer.
 */
function CollapsedIcons({ rail }: { readonly rail: RailApi }) {
  return (
    <div className={styles.icons} hidden={!rail.collapsed}>
      <ThreadListPrimitive.New asChild>
        <IconAction command="new-thread" side="right" />
      </ThreadListPrimitive.New>
      <IconAction
        command="show-threads"
        side="right"
        onClick={() => rail.reveal("threads", { toggle: true })}
      />
      <IconAction
        command="show-files"
        side="right"
        onClick={() => rail.reveal("files", { toggle: true })}
      />
    </div>
  );
}

/**
 * The Files section: nothing is listed or woken until the member asks (Open files, Show files,
 * the bar's Files); each ask, and Refresh, wakes the sandbox and lists again.
 */
function RailFiles({
  rail,
  api,
  drop,
  showFolder,
  clearDrop,
}: {
  readonly rail: RailApi;
  readonly api: FilesApi;
  readonly drop: DropStatus;
  readonly showFolder: { readonly path: string; readonly seq: number } | null;
  /** A Files action (open, refresh) clears the last drop's notice and errors. */
  clearDrop(): void;
}) {
  const request = () => {
    clearDrop();
    rail.requestFiles();
  };
  return (
    <section
      id={SECTION_IDS.files}
      aria-labelledby="kobe-rail-files-title"
      tabIndex={-1}
      className={styles.section}
    >
      <div className={styles.sectionHeader}>
        <h3 id="kobe-rail-files-title" className={styles.sectionTitle}>
          Files
        </h3>
        {rail.filesRequests > 0 && (
          <IconAction command="refresh-files" size="sm" side="right" onClick={request} />
        )}
      </div>
      <RailDropNotice status={drop} />
      {rail.filesRequests === 0 ? (
        <div className={styles.scroll}>
          <button type="button" className={styles.loadMore} onClick={request}>
            Open files
          </button>
        </div>
      ) : (
        <FileBrowser api={api} wakeKey={rail.filesRequests} showFolder={showFolder} />
      )}
    </section>
  );
}

/**
 * The workspace rail (CE2, CE5, KOBE-198): the active team's name, then Threads over Files with a
 * draggable divider, each scrolling on its own; 280 px, or 48 px collapsed to three icons. The
 * sections stay mounted (hidden) while collapsed, so their state survives and nothing re-wakes.
 * The whole rail is the drop zone for files (A3, KOBE-199, `rail-drop-zone.tsx`).
 *
 * Below 1100 px an expanded rail is a modal drawer (CE7, CE8, KOBE-201): focus moves in, the rest
 * of the chat is inert, Escape or a press outside closes it and focus returns to the control that
 * opened it. Under 768 px the collapsed rail is not shown at all; the bar opens the drawer.
 */
export function WorkspaceRail({
  teamName,
  listError,
  filesApi,
  fetchFn,
}: {
  readonly teamName: string;
  readonly listError: ApiError | null;
  readonly filesApi: FilesApi;
  readonly fetchFn: typeof fetch | undefined;
}) {
  const rail = useRail();
  if (!rail) throw new Error("WorkspaceRail needs a RailProvider");
  useFoldOnThreadChange(rail);
  const aside = useRef<HTMLElement>(null);
  const { collapsed, drawer, toggle } = rail;
  useModalLayer(aside, drawer, rail.closeDrawer, { modal: true, escape: true });
  useRevealFocus(rail);
  const sections = useRef<HTMLDivElement>(null);
  const single = useShellBand() === "single";
  const drop = useRailDropZone(filesApi, rail);

  return (
    <aside
      ref={aside}
      aria-label="Workspace"
      className={styles.rail}
      {...(collapsed ? { "data-collapsed": "" } : {})}
      {...(drawer ? { "data-drawer": "", role: "dialog", "aria-modal": true, tabIndex: -1 } : {})}
      {...drop.handlers}
    >
      {drop.active && <RailDropOverlay />}
      {!single && <CollapsedIcons rail={rail} />}
      <div className={styles.expanded} hidden={collapsed}>
        <div className={styles.header}>
          <h2 className={styles.team} title={teamName}>
            {teamName}
          </h2>
          <IconAction
            command="toggle-rail"
            label={drawer ? "Close the workspace" : undefined}
            side="right"
            aria-expanded
            aria-controls="kobe-rail-sections"
            onClick={() => toggle(true)}
          />
        </div>
        <div
          id="kobe-rail-sections"
          ref={sections}
          className={styles.sections}
          style={{ gridTemplateRows: sectionRows(rail.threadsShare) }}
        >
          <section
            id={SECTION_IDS.threads}
            aria-labelledby="kobe-rail-threads-title"
            tabIndex={-1}
            className={styles.section}
          >
            <RailThreads listError={listError} fetchFn={fetchFn} />
          </section>
          <RailDivider
            share={rail.threadsShare}
            onChange={rail.setThreadsShare}
            container={sections}
            controls={SECTION_IDS.threads}
          />
          <RailFiles
            rail={rail}
            api={filesApi}
            drop={drop.status}
            showFolder={drop.showFolder}
            clearDrop={drop.clear}
          />
        </div>
      </div>
    </aside>
  );
}
