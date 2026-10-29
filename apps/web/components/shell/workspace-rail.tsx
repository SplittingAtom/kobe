"use client";

import { ThreadListPrimitive, useAuiState } from "@assistant-ui/react";
import { useContext, useEffect, useRef } from "react";
import type { ApiError } from "../../lib/api/client";
import type { FileEntry, FilesApi } from "../../lib/files/api";
import { ErrorNotice } from "../admin/error-notice";
import { useArtifactPanel } from "../chat/artifact-state";
import { ChatSessionContext } from "../chat/kobe-runtime";
import { mentionRefusal } from "../../lib/chat/mention-insert";
import { FileBrowser } from "../files/file-browser";
import { WorkspaceConflictNotices } from "../files/workspace-conflict-notices";
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
import { useRail, type RailApi, type RailTab } from "./rail-state";
import { RAIL_TAB_IDS, RailTabList } from "./rail-tabs";
import { useShellBand } from "./shell-band";
import { useModalLayer } from "./use-modal-layer";
import { RailTeam, RailTeamIcon } from "./rail-team";
import { RailApps, hasRailApps, useRailApps } from "./rail-apps";
import styles from "./rail.module.css";
import { RAIL_ACTION, RAIL_ACTION_VARIANT } from "./rail-action";

const SECTION_IDS = { files: RAIL_TAB_IDS.files.panel, apps: RAIL_TAB_IDS.apps.panel } as const;

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
    // The tab asked for, in the rail's one section (KOBE-448).
    document.getElementById(SECTION_IDS[revealed.section])?.focus();
  }, [revealed, collapsed]);
}

/**
 * The icons of the collapsed rail (CE5): New conversation, Threads (the panel, KOBE-453) and one
 * for the Files | Apps section, which opens it on the member's last tab (KOBE-448). New keeps the
 * rail as it is. Hidden, not unmounted, while the rail is expanded, so focus can return to the
 * icon that opened a drawer.
 */
function CollapsedIcons({
  rail,
  teams,
  teamName,
  tab,
}: {
  readonly rail: RailApi;
  readonly teams: MyTeamsState;
  readonly teamName: string;
  /** The tab the section opens on: Apps only when the member has apps. */
  readonly tab: RailTab;
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
        command={tab === "apps" ? "show-apps" : "show-files"}
        side="right"
        variant={RAIL_ACTION_VARIANT}
        className={RAIL_ACTION}
        onClick={() => rail.reveal(tab, { toggle: true })}
      />
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

/**
 * Shows or hides the rail's section (KOBE-453, KOBE-448: Files, or Files | Apps; saved per
 * member). Hidden, the rail collapses to its strip.
 */
function FilesToggle({ rail, withApps }: { readonly rail: RailApi; readonly withApps: boolean }) {
  const on = shows(rail.panels, "files");
  return (
    <IconAction
      command="rail-files"
      label={withApps ? "Files and apps" : undefined}
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
  withApps,
}: {
  readonly rail: RailApi;
  readonly teams: MyTeamsState;
  readonly teamName: string;
  /** The section has an Apps tab: its toggle says so. */
  readonly withApps: boolean;
}) {
  return (
    <>
      <div className={styles.header} data-rail-header>
        <RailTeam teams={teams} teamName={teamName} />
        <div className={styles.headerActions}>
          <ThreadActions />
          <FilesToggle rail={rail} withApps={withApps} />
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
 * Lists the files the first time the Files tab is on screen in this page (KOBE-461): a tab click,
 * a load on Files, the drawer opening on Files. After that the kept listing is shown again without
 * waking (Apps then Files, collapse and expand, the drawer again); Refresh files, Show files,
 * Mod+Shift+F and `/files` list again. Only after the member's layout has loaded, so a member last
 * on Apps, or with the rail collapsed, wakes nothing.
 */
function useListWhenShown(rail: RailApi, showing: boolean) {
  const { filesRequests, requestFiles } = rail;
  useEffect(() => {
    if (showing && filesRequests === 0) requestFiles();
  }, [showing, filesRequests, requestFiles]);
}

/**
 * The Files section: listed (and the sandbox woken) the first time its tab is on screen in an
 * expanded rail (KOBE-461), never while Apps is, or the rail is collapsed. Each ask (Show files,
 * Mod+Shift+F, `/files`) and Refresh files, in the file browser's top row, wakes and lists again.
 */
function RailFiles({
  rail,
  api,
  drop,
  showFolder,
  clearDrop,
  hidden,
  tabbed,
}: {
  readonly rail: RailApi;
  readonly api: FilesApi;
  readonly drop: DropStatus;
  readonly showFolder: { readonly path: string; readonly seq: number } | null;
  /** A Files action (open, refresh) clears the last drop's notice and errors. */
  clearDrop(): void;
  /** Not on screen (Apps is, or the section is off): kept mounted (its tree, listing), not shown. */
  hidden: boolean;
  /** A tab beside Apps (KOBE-448): its tab names it, so its own title is for screen readers. */
  tabbed: boolean;
}) {
  useListWhenShown(rail, rail.settled && !hidden && !rail.collapsed);
  const refresh = () => {
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
  const content = (
    <>
      <div className={styles.sectionHeader}>
        <h3
          id="kobe-rail-files-title"
          className={tabbed ? `${styles.sectionTitle} sr-only` : styles.sectionTitle}
        >
          Files
        </h3>
      </div>
      <RailDropNotice status={drop} />
      {/* Nothing until its first showing lists it (KOBE-461): the tab on screen asks at once. */}
      {rail.filesRequests > 0 && (
        <WorkspaceConflictNotices api={api} readKey={rail.filesRequests} />
      )}
      {rail.filesRequests > 0 && (
        <FileBrowser
          api={api}
          wakeKey={rail.filesRequests}
          onRefresh={refresh}
          showFolder={showFolder}
          onOpenFile={openFile}
          onMoved={panel?.moveFiles}
          onMoveStart={panel?.beginMove}
          onMoveFailed={panel?.endMove}
          onMention={mention}
        />
      )}
    </>
  );
  // Beside Apps (KOBE-448) the Files tab's panel is the section, named by its tab (one name, no
  // second landmark inside it).
  if (tabbed) {
    return (
      <div
        id={SECTION_IDS.files}
        role="tabpanel"
        aria-labelledby={RAIL_TAB_IDS.files.tab}
        tabIndex={-1}
        className={styles.section}
        hidden={hidden}
      >
        <div className={styles.tabSection}>{content}</div>
      </div>
    );
  }
  return (
    <section
      id={SECTION_IDS.files}
      aria-labelledby="kobe-rail-files-title"
      tabIndex={-1}
      className={styles.section}
      hidden={hidden}
    >
      {content}
    </section>
  );
}

/**
 * The workspace rail (CE2, CE5, KOBE-198): its top line (KOBE-419, KOBE-453: team selector, New
 * conversation, Threads, the Files toggle, Team console, collapse), then Apps (when the member has
 * any) over Files. The threads are a panel over the workspace since KOBE-453
 * (`threads-panel.tsx`). 280 px, or 48 px collapsed to the team's initials and icons. The sections
 * stay mounted (hidden) while collapsed, so their state survives; collapsed, nothing wakes.
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
  // Files | Apps (KOBE-448): the Apps tab (KOBE-440) only when the member has apps or a key to add;
  // else the section is Files alone, without a tablist, whatever tab is stored.
  const apps = useRailApps();
  const showsApps = hasRailApps(apps);
  // A member last on Apps sees nothing else while the apps list is on its way (no Files flash).
  const appsPending = apps === null && rail.tab === "apps";
  const tab: RailTab = showsApps || appsPending ? rail.tab : "files";
  const gridRows = showsApps ? "auto minmax(0, 1fr)" : "minmax(0, 1fr)";

  return (
    <>
      <aside
        ref={aside}
        id={RAIL_ID}
        aria-label="Workspace"
        className={styles.rail}
        {...(collapsed ? { "data-collapsed": "" } : {})}
        {...(rail.pickerShown ? { "data-picker": "" } : {})}
        // The member's stored layout (tab, section, width) is applied (KOBE-415).
        {...(rail.settled ? { "data-settled": "" } : {})}
        {...(drawer ? { "data-drawer": "", role: "dialog", "aria-modal": true, tabIndex: -1 } : {})}
        {...drop.handlers}
      >
        {drop.active && <RailDropOverlay />}
        {!single && <CollapsedIcons rail={rail} teams={teams} teamName={teamName} tab={tab} />}
        <div className={styles.expanded} hidden={collapsed}>
          <RailHeader rail={rail} teams={teams} teamName={teamName} withApps={showsApps} />
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
            {showsApps && <RailTabList tab={tab} onChange={rail.setTab} />}
            <RailFiles
              rail={rail}
              api={filesApi}
              drop={drop.status}
              showFolder={drop.showFolder}
              clearDrop={drop.clear}
              hidden={!filesShown || tab !== "files"}
              tabbed={showsApps}
            />
            {appsPending && (
              <p role="status" className={styles.appsPending}>
                Loading apps…
              </p>
            )}
            {showsApps && (
              <RailApps rail={rail} apps={apps} hidden={!filesShown || tab !== "apps"} />
            )}
          </div>
        </div>
      </aside>
      {resizable && (
        <RailResizeHandle
          width={rail.shownWidth}
          onChange={rail.setWidth}
          onReset={rail.resetWidth}
        />
      )}
    </>
  );
}
