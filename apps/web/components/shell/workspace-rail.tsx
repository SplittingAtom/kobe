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
import { isNarrowScreen, sectionRows, useRail, type RailApi } from "./rail-state";
import { RailThreads } from "./rail-threads";
import styles from "./rail.module.css";

const SECTION_IDS = { threads: "kobe-rail-threads", files: "kobe-rail-files" } as const;

/** On one column the rail folds once a thread is on screen, however it was opened (A5 slot). */
function useFoldOnThreadChange({ setCollapsed }: RailApi) {
  const threadId = useAuiState((s) => s.threadListItem.id);
  const seen = useRef(threadId);
  useEffect(() => {
    if (seen.current === threadId) return;
    seen.current = threadId;
    if (isNarrowScreen()) setCollapsed(true);
  }, [threadId, setCollapsed]);
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

/** The three icons of the collapsed rail (CE5). New keeps the rail as it is. */
function CollapsedIcons({ rail }: { readonly rail: RailApi }) {
  return (
    <div className={styles.icons}>
      <ThreadListPrimitive.New asChild>
        <IconAction command="new-thread" side="right" />
      </ThreadListPrimitive.New>
      <IconAction command="show-threads" side="right" onClick={() => rail.reveal("threads")} />
      <IconAction command="show-files" side="right" onClick={() => rail.reveal("files")} />
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
}: {
  readonly rail: RailApi;
  readonly api: FilesApi;
  readonly drop: DropStatus;
  readonly showFolder: { readonly path: string; readonly seq: number } | null;
}) {
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
          <IconAction command="refresh-files" size="sm" side="right" onClick={rail.requestFiles} />
        )}
      </div>
      <RailDropNotice status={drop} />
      {rail.filesRequests === 0 ? (
        <div className={styles.scroll}>
          <button type="button" className={styles.loadMore} onClick={rail.requestFiles}>
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
  useRevealFocus(rail);
  const sections = useRef<HTMLDivElement>(null);
  const { collapsed } = rail;
  const drop = useRailDropZone(filesApi, rail);

  return (
    <aside
      aria-label="Workspace"
      className={styles.rail}
      {...(collapsed ? { "data-collapsed": "" } : {})}
      {...drop.handlers}
    >
      {drop.active && <RailDropOverlay />}
      {collapsed && <CollapsedIcons rail={rail} />}
      <div className={styles.expanded} hidden={collapsed}>
        <div className={styles.header}>
          <h2 className={styles.team} title={teamName}>
            {teamName}
          </h2>
          <IconAction
            command="toggle-rail"
            side="right"
            aria-expanded
            aria-controls="kobe-rail-sections"
            onClick={() => rail.setCollapsed(true)}
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
          <RailFiles rail={rail} api={filesApi} drop={drop.status} showFolder={drop.showFolder} />
        </div>
      </div>
    </aside>
  );
}
