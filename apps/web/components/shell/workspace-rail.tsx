"use client";

import { ThreadListPrimitive, useAuiState } from "@assistant-ui/react";
import { useEffect, useRef, useState } from "react";
import type { ApiError } from "../../lib/api/client";
import type { FilesApi } from "../../lib/files/api";
import { FileBrowser } from "../files/file-browser";
import { IconAction } from "./icon-action";
import { RailDivider } from "./rail-divider";
import { isNarrowScreen, useRail, type RailApi } from "./rail-state";
import { RailThreads } from "./rail-threads";
import styles from "./rail.module.css";

/** A share as a grid track, without float noise (0.45, not 0.44999999999999996). */
const fr = (share: number) => `${Math.round(share * 1000) / 1000}fr`;

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

function CollapsedRail({ rail }: { readonly rail: RailApi }) {
  return (
    <aside aria-label="Workspace" className={styles.rail} data-collapsed="">
      <ThreadListPrimitive.New asChild onClick={() => rail.setCollapsed(false)}>
        <IconAction command="new-thread" side="right" />
      </ThreadListPrimitive.New>
      <IconAction command="show-threads" side="right" onClick={() => rail.reveal("threads")} />
      <IconAction command="show-files" side="right" onClick={() => rail.reveal("files")} />
    </aside>
  );
}

/**
 * The workspace rail (CE2, CE5, KOBE-198): the active team's name, then Threads over Files with a
 * draggable divider, each scrolling on its own; 280 px, or 48 px collapsed to three icons.
 * Slot (A3, KOBE-199): the whole rail becomes the drop zone for files.
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
  // Waking the sandbox waits until the member reaches for Files (KOBE-151 woke on opening).
  const [filesUsed, setFilesUsed] = useState(false);
  if (rail.collapsed) return <CollapsedRail rail={rail} />;

  const share = rail.threadsShare;
  return (
    <aside aria-label="Workspace" className={styles.rail}>
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
        style={{ gridTemplateRows: `minmax(0, ${fr(share)}) auto minmax(0, ${fr(1 - share)})` }}
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
          share={share}
          onChange={rail.setThreadsShare}
          container={sections}
          controls={SECTION_IDS.threads}
        />
        <section
          id={SECTION_IDS.files}
          aria-labelledby="kobe-rail-files-title"
          tabIndex={-1}
          className={styles.section}
          onFocus={() => setFilesUsed(true)}
          onPointerDown={() => setFilesUsed(true)}
        >
          <div className={styles.sectionHeader}>
            <h3 id="kobe-rail-files-title" className={styles.sectionTitle}>
              Files
            </h3>
          </div>
          <FileBrowser api={filesApi} wake={filesUsed} />
        </section>
      </div>
    </aside>
  );
}
