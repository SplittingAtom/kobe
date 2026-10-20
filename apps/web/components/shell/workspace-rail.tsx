"use client";

import { ThreadListPrimitive, useAuiState } from "@assistant-ui/react";
import { useContext, useEffect, useRef, useState } from "react";
import type { ApiError } from "../../lib/api/client";
import type { FileEntry, FilesApi } from "../../lib/files/api";
import { ErrorNotice } from "../admin/error-notice";
import { useArtifactPanel } from "../chat/artifact-state";
import { ChatSessionContext } from "../chat/kobe-runtime";
import { mentionRefusal } from "../../lib/chat/mention-insert";
import { FileBrowser } from "../files/file-browser";
import { useMyTeams, type MyTeamsState } from "../../app/team-switcher";
import { useOpenConsoles } from "../admin/console-links";
import { shows } from "../../lib/shell/rail-panels";
import { THREADS_PANEL_HREF } from "../../lib/shell/panels";
import { shortcutOf } from "../../lib/shell/shortcuts";
import { IconAction } from "./icon-action";
import { useOpenPanel } from "./panel-close";
import { OVERALL_LABEL, useOverallActivity } from "../chat/thread-activity";
import {
  RailDropNotice,
  RailDropOverlay,
  useRailDropZone,
  type DropStatus,
} from "./rail-drop-zone";
import { railDocked } from "../../lib/shell/layout";
import { RAIL_ID, RailResizeHandle } from "./rail-resize";
import { useRail, type RailApi } from "./rail-state";
import { useShellBand } from "./shell-band";
import { useModalLayer } from "./use-modal-layer";
import { RailTeam, RailTeamIcon } from "./rail-team";
import { RailApps, hasRailApps, useRailApps } from "./rail-apps";
import styles from "./rail.module.css";
import { RAIL_ACTION, RAIL_ACTION_VARIANT } from "./rail-action";

const SECTION_IDS = { files: "kobe-rail-files" } as const;

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
    // The rail has one section since KOBE-453 (the threads are a panel): Files.
    document.getElementById(SECTION_IDS.files)?.focus();
  }, [revealed, collapsed]);
}

/**
 * The icons of the collapsed rail (CE5): New conversation, Threads (the panel, KOBE-453), Files and
 * Apps. New keeps the rail as it is. Hidden, not unmounted,
 * while the rail is expanded, so focus can return to the icon that opened a drawer.
 */
function CollapsedIcons({
  rail,
  teams,
  teamName,
  onShowApps,
}: {
  readonly rail: RailApi;
  readonly teams: MyTeamsState;
  readonly teamName: string;
  /** Present when the member has apps (KOBE-440): expands the rail at its Apps section. */
  readonly onShowApps?: (() => void) | undefined;
}) {
  return (
    <div className={styles.icons} hidden={!rail.collapsed}>
      <RailTeamIcon teams={teams} teamName={teamName} />
      <ThreadListPrimitive.New asChild>
        <IconAction
          command="new-thread"
          side="right"
          variant={RAIL_ACTION_VARIANT}
          className={RAIL_ACTION}
        />
      </ThreadListPrimitive.New>
      <ThreadsButton command="show-threads" side="right" className={RAIL_ACTION} />
      <IconAction
        command="show-files"
        side="right"
        variant={RAIL_ACTION_VARIANT}
        className={RAIL_ACTION}
        onClick={() => rail.reveal("files", { toggle: true })}
      />
      {onShowApps && (
        <IconAction
          command="show-apps"
          side="right"
          variant={RAIL_ACTION_VARIANT}
          className={RAIL_ACTION}
          onClick={onShowApps}
        />
      )}
    </div>
  );
}

/**
 * Opens the Threads panel over the workspace (KOBE-453). With the rows out of the rail, it carries
 * their activity: a dot while any conversation runs or waits for the member's approval.
 */
function ThreadsButton({
  command,
  size,
  side,
  className,
}: {
  readonly command: "rail-threads" | "show-threads";
  readonly size?: "sm";
  readonly side: "bottom" | "right";
  readonly className: string;
}) {
  const openPanel = useOpenPanel();
  const activity = useOverallActivity();
  return (
    <IconAction
      command={command}
      badge={activity === "idle" ? undefined : OVERALL_LABEL[activity]}
      data-kobe-activity={activity}
      size={size}
      side={side}
      variant={RAIL_ACTION_VARIANT}
      className={className}
      aria-haspopup="dialog"
      onClick={() => openPanel?.(THREADS_PANEL_HREF)}
    />
  );
}

/**
 * New conversation, then Threads, which opens the Threads panel over the workspace (KOBE-453):
 * New sits immediately left of it.
 */
function ThreadActions() {
  return (
    <>
      <ThreadListPrimitive.New asChild>
        <IconAction
          command="new-thread"
          size="sm"
          side="bottom"
          variant={RAIL_ACTION_VARIANT}
          className={`size-7 ${RAIL_ACTION}`}
        />
      </ThreadListPrimitive.New>
      <ThreadsButton
        command="rail-threads"
        size="sm"
        side="bottom"
        className={`size-7 ${RAIL_ACTION}`}
      />
    </>
  );
}

/** Shows or hides the rail's Files section (KOBE-453: the rail's one section; saved per member). */
function FilesToggle({ rail }: { readonly rail: RailApi }) {
  const on = shows(rail.panels, "files");
  return (
    <IconAction
      command="rail-files"
      size="sm"
      side="bottom"
      variant={RAIL_ACTION_VARIANT}
      className={`size-7 ${RAIL_ACTION}`}
      shortcut={shortcutOf("files")}
      aria-pressed={on}
      aria-controls={SECTION_IDS.files}
      onClick={() => rail.setSectionShown(!on)}
    />
  );
}

/** Team console, for the members the server lets in (team admins; KOBE-419: from the bar). */
function TeamConsoleLink() {
  const consoles = useOpenConsoles();
  if (!consoles.includes("team")) return null;
  return (
    <IconAction
      command="team-console"
      size="sm"
      side="bottom"
      variant={RAIL_ACTION_VARIANT}
      className={`size-7 ${RAIL_ACTION}`}
    />
  );
}

/**
 * The rail's top line (KOBE-419, KOBE-453): the team selector, New conversation, Threads (the
 * panel), the Files toggle, Team console for team admins, then collapse. The name truncates; the buttons never shrink or wrap.
 */
function RailHeader({
  rail,
  teams,
  teamName,
}: {
  readonly rail: RailApi;
  readonly teams: MyTeamsState;
  readonly teamName: string;
}) {
  return (
    <>
      <div className={styles.header} data-rail-header>
        <RailTeam teams={teams} teamName={teamName} />
        <div className={styles.headerActions}>
          <ThreadActions />
          <FilesToggle rail={rail} />
          <TeamConsoleLink />
          <IconAction
            command="toggle-rail"
            label={rail.drawer ? "Close the workspace" : undefined}
            side="right"
            size="sm"
            variant={RAIL_ACTION_VARIANT}
            className={`size-7 ${RAIL_ACTION}`}
            aria-expanded
            aria-controls="kobe-rail-sections"
            onClick={() => rail.toggle(true)}
          />
        </div>
      </div>
      {teams.error !== null && (
        <p role="alert" className={styles.teamError}>
          {teams.error}
        </p>
      )}
    </>
  );
}

/**
 * The Files section: nothing is listed or woken until the member asks (Open files, Show files,
 * Mod+Shift+F, `/files`); each ask, and Refresh, wakes the sandbox and lists again.
 */
function RailFiles({
  rail,
  api,
  drop,
  showFolder,
  clearDrop,
  hidden,
}: {
  readonly rail: RailApi;
  readonly api: FilesApi;
  readonly drop: DropStatus;
  readonly showFolder: { readonly path: string; readonly seq: number } | null;
  /** A Files action (open, refresh) clears the last drop's notice and errors. */
  clearDrop(): void;
  /** Turned off on the rail's top line: kept mounted (its tree and listing), not shown. */
  hidden: boolean;
}) {
  const request = () => {
    clearDrop();
    rail.requestFiles();
  };
  const panel = useArtifactPanel();
  // A file opens in the artifact column (KOBE-268); the drawer (under 1100 px) makes way for it.
  const openFile = panel
    ? (entry: FileEntry) => {
        if (rail.drawer) rail.closeDrawer();
        panel.openFile(entry.path);
      }
    : undefined;
  // "Mention in message" (KOBE-374): into the composer on screen, which the drawer makes way for.
  const session = useContext(ChatSessionContext);
  const mention = session
    ? (entry: FileEntry) => {
        const refused =
          mentionRefusal(entry.path, entry.type) ?? session.composerMentions.request(entry.path);
        if (refused === undefined && rail.drawer) rail.closeDrawer();
        return refused;
      }
    : undefined;
  return (
    <section
      id={SECTION_IDS.files}
      aria-labelledby="kobe-rail-files-title"
      tabIndex={-1}
      className={styles.section}
      hidden={hidden}
    >
      <div className={styles.sectionHeader}>
        <h3 id="kobe-rail-files-title" className={styles.sectionTitle}>
          Files
        </h3>
        {rail.filesRequests > 0 && (
          <IconAction
            command="refresh-files"
            size="sm"
            side="right"
            variant={RAIL_ACTION_VARIANT}
            className={RAIL_ACTION}
            onClick={request}
          />
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
        <FileBrowser
          api={api}
          wakeKey={rail.filesRequests}
          showFolder={showFolder}
          onOpenFile={openFile}
          onMoved={panel?.moveFiles}
          onMention={mention}
        />
      )}
    </section>
  );
}

/**
 * The workspace rail (CE2, CE5, KOBE-198): its top line (KOBE-419, KOBE-453: team selector, New
 * conversation, Threads, the Files toggle, Team console, collapse), then Apps (when the member has
 * any) over Files. The threads are a panel over the workspace since KOBE-453
 * (`threads-panel.tsx`). 280 px, or 48 px collapsed to the team's initials and icons. The sections
 * stay mounted (hidden) while collapsed, so their state survives and nothing re-wakes.
 * The whole rail is the drop zone for files (A3, KOBE-199, `rail-drop-zone.tsx`).
 *
 * Below 1100 px an expanded rail is a modal drawer (CE7, CE8, KOBE-201): focus moves in, the rest
 * of the chat is inert, Escape or a press outside closes it and focus returns to the control that
 * opened it. Under 768 px the collapsed rail is not shown at all; the bar opens the drawer.
 *
 * On wide windows the expanded rail has a drag handle on its right edge (KOBE-305,
 * `rail-resize.tsx`), beside the aside so it is laid out against the grid, not the rail's scroll.
 */
export function WorkspaceRail({
  teamName,
  listError,
  filesApi,
}: {
  readonly teamName: string;
  /** A thread could not be read (the list, or the one opened): said here and in the Threads panel. */
  readonly listError: ApiError | null;
  readonly filesApi: FilesApi;
}) {
  const rail = useRail();
  if (!rail) throw new Error("WorkspaceRail needs a RailProvider");
  useFoldOnThreadChange(rail);
  const aside = useRef<HTMLElement>(null);
  const { collapsed, drawer } = rail;
  useModalLayer(aside, drawer, rail.closeDrawer, { modal: true, escape: true });
  useRevealFocus(rail);
  const band = useShellBand();
  const single = band === "single";
  const resizable = railDocked(band) && !collapsed && !drawer;
  const drop = useRailDropZone(filesApi, rail);
  // One read of the member's teams for the top line and the collapsed strip.
  const teams = useMyTeams(false);
  const filesShown = shows(rail.panels, "files");
  // The Apps section (KOBE-440) sits between Threads and Files, only when the member has apps.
  const apps = useRailApps();
  const showsApps = hasRailApps(apps);
  const [appsFocus, setAppsFocus] = useState(0);
  const showApps = () => {
    rail.toggle(false);
    setAppsFocus((n) => n + 1);
  };
  const gridRows = showsApps && filesShown ? "auto minmax(0, 1fr)" : "minmax(0, 1fr)";

  return (
    <>
      <aside
        ref={aside}
        id={RAIL_ID}
        aria-label="Workspace"
        className={styles.rail}
        {...(collapsed ? { "data-collapsed": "" } : {})}
        {...(drawer ? { "data-drawer": "", role: "dialog", "aria-modal": true, tabIndex: -1 } : {})}
        {...drop.handlers}
      >
        {drop.active && <RailDropOverlay />}
        {!single && (
          <CollapsedIcons
            rail={rail}
            teams={teams}
            teamName={teamName}
            onShowApps={showsApps ? showApps : undefined}
          />
        )}
        <div className={styles.expanded} hidden={collapsed}>
          <RailHeader rail={rail} teams={teams} teamName={teamName} />
          {listError && (
            <div className={styles.listError}>
              <ErrorNotice error={listError} />
            </div>
          )}
          <div
            id="kobe-rail-sections"
            className={styles.sections}
            style={{ gridTemplateRows: gridRows }}
          >
            {showsApps && filesShown && <RailApps rail={rail} apps={apps} focusSeq={appsFocus} />}
            <RailFiles
              rail={rail}
              api={filesApi}
              drop={drop.status}
              showFolder={drop.showFolder}
              clearDrop={drop.clear}
              hidden={!filesShown}
            />
          </div>
        </div>
      </aside>
      {resizable && (
        <RailResizeHandle width={rail.width} onChange={rail.setWidth} onReset={rail.resetWidth} />
      )}
    </>
  );
}
