"use client";

import "../../lib/security/zod-jitless";
import { AssistantRuntimeProvider, Suggestions, useAui } from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { TeamInvites } from "../../app/team-invites";
import { TeamActivation } from "../../app/team-switcher";
import type { ApiError } from "../../lib/api/client";
import { createChatApi } from "../../lib/chat/api";
import { browserThreadListSync, type ThreadListSync } from "../../lib/chat/thread-list-sync";
import { ChatSession } from "../../lib/chat/session";
import type { EventSourceFactory } from "../../lib/chat/stream";
import type { UploadTransport } from "../../lib/chat/uploads";
import { createThreadListAdapter } from "../../lib/chat/thread-list-adapter";
import { ACTIVE_TEAM_EVENT, fetchMyTeams } from "../../lib/teams";
import { createFilesApi } from "../../lib/files/api";
import { AREAS, areaFromUrl, onChatPage } from "../../lib/shell/areas";
import { lastThreadHref, lastThreadId, rememberLastThread } from "../../lib/shell/last-thread";
import { followWorkspaceEntries, stepsBackToWorkspace } from "../../lib/shell/panel-history";
import { panelOfPath, type Panel } from "../../lib/shell/panels";
import { ArtifactPanel } from "./artifact-panel";
import { ArtifactPanelProvider, useArtifactPanel } from "./artifact-state";
import { AppCommands } from "../shell/app-commands";
import { CommandBindingsProvider } from "../shell/command-bindings";
import { CommandPalette } from "../shell/command-palette";
import { ShortcutKeys } from "../shell/shortcut-keys";
import { ShortcutSheet } from "../shell/shortcut-sheet";
import { ThreadGroupsProvider } from "../shell/thread-groups";
import { ShellGrid } from "../shell/shell-grid";
import { RailDrawerButton, RailProvider, useRail } from "../shell/rail-state";
import { ShellBandProvider } from "../shell/shell-band";
import { useLayoutPreferences } from "../../lib/shell/preferences";
import { DetailProvider } from "./detail";
import { AnswerFeedbackProvider } from "./answer-feedback";
import { ThreadUsageProvider } from "./message-footer";
import { TeamModelsProvider } from "./use-team-models";
import { ThreadMarkersProvider } from "./markers";
import { ThreadAppsProvider } from "../apps/thread-apps";
import { OpenPanelContext } from "../shell/panel-close";
import { WorkspacePanel } from "../shell/workspace-panel";
import { ThreadsPanelContent } from "../shell/threads-panel";
import { WorkspaceRail } from "../shell/workspace-rail";
import { FileGoneNotice } from "../files/file-tab";
import { IconActionProvider } from "../shell/icon-action";
import { InlineLink } from "../shell/text-links";
import { ShellSlot, ShellSlotsProvider, useBarMenu } from "../shell/shell-slots";
import { ThreadSearch } from "../shell/thread-search";
import { UtilityBar } from "../shell/utility-bar";
import { ChatSessionContext, useKobeRuntime } from "./kobe-runtime";
import { RetentionNotice } from "./retention-notice";
import { SavedSkillNotice } from "./saved-skill-notice";
import { ThreadActivityWatch } from "./thread-activity";
import { ThreadView } from "./thread-view";
import { useViewportHeight } from "./use-viewport-height";
import styles from "./chat.module.css";

const THREAD_PARAM = "thread";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function threadFromUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const id = new URLSearchParams(window.location.search).get(THREAD_PARAM) ?? "";
  return UUID.test(id) ? id.toLowerCase() : undefined;
}

/**
 * `?thread=<id>` follows the thread on screen, so a link or a refresh reopens it. Under a panel
 * (KOBE-452) the address is the panel's: the workspace keeps its thread (opened by a link or a
 * reload, the one last on screen in this tab), and follows the address again once the chat is.
 */
function useThreadUrl(
  teamId: string,
  pathname: string,
): readonly [string | undefined, (id: string | undefined) => void] {
  const [threadId, setThreadId] = useState<string | undefined>(() =>
    onChatPage() ? threadFromUrl() : lastThreadId(teamId),
  );
  useEffect(() => {
    const onPop = () => {
      if (onChatPage()) setThreadId(threadFromUrl());
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  // Back on the chat from a panel (Close, or a link to a thread): its address names the thread.
  useEffect(() => {
    if (pathname === "/" && onChatPage()) setThreadId(threadFromUrl());
  }, [pathname]);
  const change = useCallback((id: string | undefined) => {
    setThreadId(id);
    // Under a panel the thread changes without touching its address (Close returns to it).
    if (!onChatPage() || threadFromUrl() === id) return;
    const url = new URL(window.location.href);
    if (id === undefined) url.searchParams.delete(THREAD_PARAM);
    else url.searchParams.set(THREAD_PARAM, id);
    window.history.pushState(null, "", url);
  }, []);
  return [threadId, change];
}

/**
 * How the workspace moves between the chat and its panels (KOBE-452): the router's address and
 * page, from the root layout (components/shell/workspace-host.tsx). Without one (tests of the chat
 * alone) the chat is all there is.
 */
export interface WorkspaceRoute {
  readonly pathname: string;
  /** The route's page: shown in the panel when `pathname` names one. */
  readonly page: ReactNode;
  readonly push: (href: string) => void;
  readonly replace: (href: string) => void;
}

/**
 * Without the router (the chat rendered alone, in tests), the address itself: `history` moves it
 * and Back and Forward follow, so the panels that live in the workspace (Threads, KOBE-453) open
 * and close as they do under Next.
 */
function useHistoryRoute(route: WorkspaceRoute | undefined): WorkspaceRoute {
  const [pathname, setPathname] = useState(() =>
    typeof window === "undefined" ? "/" : window.location.pathname,
  );
  useEffect(() => {
    if (route) return;
    const follow = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", follow);
    return () => window.removeEventListener("popstate", follow);
  }, [route]);
  const own = useMemo<WorkspaceRoute>(() => {
    const go = (href: string, replace: boolean) => {
      if (replace) window.history.replaceState(null, "", href);
      else window.history.pushState(null, "", href);
      setPathname(window.location.pathname);
    };
    return {
      pathname,
      page: null,
      push: (href) => go(href, false),
      replace: (href) => go(href, true),
    };
  }, [pathname]);
  return route ?? own;
}

/** Opens a thread from outside the workspace (the bell in the bar): `useThreadUrl` follows. */
function openThreadInChat(id: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set(THREAD_PARAM, id);
  window.history.pushState(null, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

type TeamState =
  | { readonly status: "loading" }
  | { readonly status: "signedOut" }
  | { readonly status: "noTeam" }
  /** Teams but none active yet: `TeamActivation` is choosing one (KOBE-419 review S3). */
  | { readonly status: "choosing" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly teamId: string; readonly teamName: string };

/** The active team (D9), asked again when the switcher activates one on first load. */
function useActiveTeam(fetchFn?: typeof fetch): TeamState {
  const [state, setState] = useState<TeamState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const retry = () => setAttempt((n) => n + 1);
    window.addEventListener(ACTIVE_TEAM_EVENT, retry);
    return () => window.removeEventListener(ACTIVE_TEAM_EVENT, retry);
  }, []);
  useEffect(() => {
    let current = true;
    fetchMyTeams(fetchFn).then(
      (my) => {
        if (!current) return;
        if (my === null) setState({ status: "signedOut" });
        else if (my.activeTeamId === null) {
          setState({ status: my.teams.length > 0 ? "choosing" : "noTeam" });
        } else {
          const active = my.teams.find((t) => t.id === my.activeTeamId);
          setState({ status: "ready", teamId: my.activeTeamId, teamName: active?.name ?? "" });
        }
      },
      (e: unknown) => {
        if (current) {
          setState({
            status: "error",
            message: e instanceof Error ? e.message : "Could not load your teams.",
          });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [attempt, fetchFn]);
  return state;
}

/** The shell grid with the rail's and the artifact column's dragged widths (CE6) and sheet (CE7). */
function WorkspaceGrid(
  props: Omit<
    Parameters<typeof ShellGrid>[0],
    "artifactWidth" | "railWidth" | "artifactSheet" | "artifactHidden"
  >,
) {
  const panel = useArtifactPanel();
  const rail = useRail();
  return (
    <ShellGrid
      {...props}
      artifactWidth={panel?.width ?? null}
      railWidth={rail?.width ?? null}
      artifactSheet={panel?.sheetOpen ?? false}
      artifactHidden={panel?.hidden ?? false}
    />
  );
}

/** Starter prompts on an empty conversation; picking one fills the composer. */
const STARTER_SUGGESTIONS = [
  {
    title: "Analyse a spreadsheet",
    label: "and chart the result",
    prompt: "Analyse the CSV in my workspace and chart the most important trend.",
  },
  {
    title: "Write a script",
    label: "and run it in the sandbox",
    prompt: "Write a Python script that renames the files in my workspace by date, and run it.",
  },
  {
    title: "Summarise my workspace",
    label: "what is in it?",
    prompt: "List the files in my workspace and summarise what each one is for.",
  },
];

function ChatWorkspace({
  session,
  teamName,
  fetchFn,
  activityPollMs,
  pathname,
  replace,
  onClosePanel,
}: {
  readonly session: ChatSession;
  /** The address (KOBE-452): the chat, or a panel over it. */
  readonly pathname: string;
  readonly replace: ((href: string) => void) | undefined;
  /** Closes the panel open over the workspace (the Threads panel renders in here). */
  readonly onClosePanel: () => void;
  readonly activityPollMs: number | undefined;
  /** The rail's header (CE2): the workspace is the member's view of this team. */
  readonly teamName: string;
  readonly fetchFn: typeof fetch | undefined;
}) {
  const filesApi = useMemo(() => createFilesApi(session.teamId, fetchFn), [session, fetchFn]);
  const [threadId, setThreadId] = useThreadUrl(session.teamId, pathname);
  // The panels return here, to this thread (CE4, KOBE-452).
  useEffect(() => rememberLastThread(session.teamId, threadId), [session, threadId]);
  // The thread on screen is seen: never "new activity" (KOBE-453, the Threads button's dot).
  useEffect(() => session.activity.setOnScreen(threadId ?? null), [session, threadId]);
  // A link from before KOBE-452 (`/?thread=…&area=memory`) opens that page's panel over the thread.
  useEffect(() => {
    const area = onChatPage() ? areaFromUrl() : undefined;
    if (area === undefined || replace === undefined) return;
    rememberLastThread(session.teamId, threadFromUrl());
    replace(AREAS[area].href);
    // Read once: the address of the first render.
  }, [session]);
  // The one-row bar's Menu closes once another thread is on screen (a search hit, the bell).
  const { setOpen: setBarMenuOpen } = useBarMenu();
  useEffect(() => setBarMenuOpen(false), [threadId, setBarMenuOpen]);
  const [listError, setListError] = useState<ApiError | null>(null);
  const adapter = useMemo(
    () => createThreadListAdapter(session, { onError: setListError }),
    [session],
  );
  // `/?project=<id>` starts the next new conversation inside that project (KOBE-164).
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("project") ?? "";
    if (UUID.test(id) && threadId === undefined) session.setDraftProject(id.toLowerCase());
    // Read once per session: the address changes when a thread opens, the draft must not.
  }, [session]);
  const runtime = useKobeRuntime({ session, adapter, threadId, onThreadIdChange: setThreadId });
  // A thread created by its first message: read the list again for its title.
  useEffect(() => session.onThreadCreated(() => void runtime.threads.reload()), [session, runtime]);
  // The server titled a thread after its first answer (KOBE-219): the rail reads the list again.
  useEffect(
    () => session.onThreadRetitled(() => void runtime.threads.reload()),
    [session, runtime],
  );
  // Pinned, archived or moved, in this tab or another one (CE19, KOBE-220).
  useEffect(
    () => session.onThreadListChanged(() => void runtime.threads.reload()),
    [session, runtime],
  );
  const aui = useAui({ suggestions: Suggestions(STARTER_SUGGESTIONS) });
  const panel = panelOfPath(pathname);
  const threadsPanel: Panel | undefined = panel?.id === "threads" ? panel : undefined;
  // A thread chosen in the Threads panel is on screen (assistant-ui switched to it): the panel's
  // entry becomes that thread's, so Back returns to the conversation before it.
  const chooseThread = useCallback(
    (id: string) => {
      if (replace !== undefined) replace(`/?thread=${id}`);
      else onClosePanel();
    },
    [replace, onClosePanel],
  );
  // Another thread on screen while the Threads panel is open (its title, Regenerate, Make a skill
  // from this): the panel closes onto it.
  const shownAtOpen = useRef<string | undefined>(undefined);
  const threadsOpen = threadsPanel !== undefined;
  useEffect(() => {
    if (!threadsOpen) return;
    shownAtOpen.current = threadId;
    // Only the thread on screen when the panel opened: later switches are below.
  }, [threadsOpen]);
  useEffect(() => {
    if (threadsOpen && threadId !== undefined && threadId !== shownAtOpen.current) {
      chooseThread(threadId);
    }
  }, [threadsOpen, threadId, chooseThread]);
  // The member's layout, from any device (CE8): loaded once, changes saved debounced.
  const layout = useLayoutPreferences(fetchFn);
  return (
    <AssistantRuntimeProvider aui={aui} runtime={runtime}>
      {/* What each action does now: the `/` menu (KOBE-224), the palette and keys (KOBE-225). */}
      <CommandBindingsProvider>
        <RetentionNotice />
        <SavedSkillNotice />
        <ThreadGroupsProvider fetchFn={fetchFn}>
          <RailProvider preferences={layout.preferences} onSave={layout.save}>
            <DetailProvider preferences={layout.preferences} onSave={layout.save}>
              <ThreadUsageProvider>
                <AnswerFeedbackProvider>
                  <TeamModelsProvider>
                    <ThreadMarkersProvider>
                      <ThreadAppsProvider>
                        <ArtifactPanelProvider
                          teamId={session.teamId}
                          threadId={threadId}
                          preferences={layout.preferences}
                          onSavePreferences={layout.save}
                        >
                          <FileGoneNotice />
                          {/* The rail's run and approval dots stay current; the tab title (KOBE-301). */}
                          <ThreadActivityWatch pollMs={activityPollMs} />
                          <AppCommands />
                          {/* CE23 (KOBE-225): the keys, the palette and the `?` sheet run the bindings. */}
                          <ShortcutKeys />
                          <CommandPalette onOpenThread={setThreadId} />
                          <ShortcutSheet />
                          <ShellSlot name="search">
                            <ThreadSearch onOpenThread={setThreadId} />
                          </ShellSlot>
                          <ShellSlot name="nav">
                            <RailDrawerButton teamName={teamName} />
                          </ShellSlot>
                          <WorkspaceGrid
                            rail={
                              <WorkspaceRail
                                teamName={teamName || "Workspace"}
                                listError={listError}
                                filesApi={filesApi}
                              />
                            }
                            artifact={<ArtifactPanel filesApi={filesApi} />}
                            conversation={
                              <main id="kobe-chat-main" className={styles.main} tabIndex={-1}>
                                <ThreadView onOpenThread={setThreadId} inShell />
                              </main>
                            }
                          />
                          {/* The Threads panel (KOBE-453) needs the thread list: it renders in here. */}
                          {threadsPanel !== undefined && (
                            <WorkspacePanel
                              panel={threadsPanel}
                              path={pathname}
                              onClose={onClosePanel}
                            >
                              <ThreadsPanelContent listError={listError} onChosen={chooseThread} />
                            </WorkspacePanel>
                          )}
                        </ArtifactPanelProvider>
                      </ThreadAppsProvider>
                    </ThreadMarkersProvider>
                  </TeamModelsProvider>
                </AnswerFeedbackProvider>
              </ThreadUsageProvider>
            </DetailProvider>
          </RailProvider>
        </ThreadGroupsProvider>
      </CommandBindingsProvider>
    </AssistantRuntimeProvider>
  );
}

export interface ChatAppProps {
  /** Tests inject the API transport and the event stream. */
  readonly fetchFn?: typeof fetch | undefined;
  readonly eventSource?: EventSourceFactory | undefined;
  readonly newKey?: (() => string) | undefined;
  readonly reopenDelayMs?: ((attempt: number) => number) | undefined;
  readonly uploadTransport?: UploadTransport | undefined;
  /** This browser's other tabs (CE19); default: a `BroadcastChannel` per team. */
  readonly threadListSync?: ((teamId: string) => ThreadListSync | undefined) | undefined;
  /** How often the rail rereads an active thread's state (KOBE-301); tests shorten it. */
  readonly activityPollMs?: number | undefined;
  /** The router's address and page: a panel over the workspace (KOBE-452). */
  readonly route?: WorkspaceRoute | undefined;
}

/**
 * The chat app (KOBE-32; v1.1 shell KOBE-197): the two-row utility bar on top, then the rail,
 * artifact column and conversation. Everything goes through the server's APIs with the session
 * cookie from this browser; nothing is fetched or cached on the Next.js server.
 */
export function ChatApp({
  fetchFn,
  eventSource,
  newKey,
  reopenDelayMs,
  uploadTransport,
  threadListSync = browserThreadListSync,
  activityPollMs,
  route: givenRoute,
}: ChatAppProps) {
  const route = useHistoryRoute(givenRoute);
  const team = useActiveTeam(fetchFn);
  const teamId = team.status === "ready" ? team.teamId : null;
  const session = useMemo(
    () =>
      teamId === null
        ? null
        : new ChatSession({
            teamId,
            api: createChatApi(teamId, fetchFn),
            eventSource,
            newKey,
            reopenDelayMs,
            uploadTransport,
            fetchFn,
            listSync: threadListSync(teamId),
          }),
    [teamId, fetchFn, eventSource, newKey, reopenDelayMs, uploadTransport, threadListSync],
  );
  useEffect(() => () => session?.dispose(), [session]);
  const [appEl, setAppEl] = useState<HTMLDivElement | null>(null);
  useViewportHeight(appEl);
  const { pathname } = route;
  const panel = panelOfPath(pathname);
  // The chat entry a panel returns to (KOBE-452): the latest one shown without a panel.
  useEffect(() => followWorkspaceEntries(onChatPage), []);
  const closePanel = useCallback(() => {
    const steps = stepsBackToWorkspace();
    if (steps !== null) window.history.go(steps);
    else route.replace(lastThreadHref(teamId));
  }, [route, teamId]);
  // The bell under a panel: the thread opens in the chat, and the panel closes.
  const openThreadFromHeader = useCallback(
    (id: string) => {
      if (panel !== undefined) route.push(`/?thread=${id}`);
      else openThreadInChat(id);
    },
    [panel, route],
  );

  let body: ReactNode;
  if (team.status === "loading" || team.status === "choosing")
    body = (
      <p className={styles.empty} role="status">
        {team.status === "choosing" ? "Choosing your team…" : "Loading…"}
      </p>
    );
  else if (team.status === "signedOut") {
    body = (
      <p className={styles.empty}>
        <InlineLink href="/sign-in">Sign in</InlineLink> to chat with your agents.
      </p>
    );
  } else if (team.status === "noTeam") {
    body = (
      <p className={styles.empty}>You are not in any team yet. Ask an admin to add you to one.</p>
    );
  } else if (team.status === "error") {
    body = (
      <p className={styles.empty} role="alert">
        {team.message}
      </p>
    );
  } else if (session) {
    body = (
      <ChatSessionContext.Provider value={session}>
        <ChatWorkspace
          key={session.teamId}
          session={session}
          teamName={team.status === "ready" ? team.teamName : ""}
          fetchFn={fetchFn}
          activityPollMs={activityPollMs}
          pathname={pathname}
          replace={route.replace}
          onClosePanel={closePanel}
        />
      </ChatSessionContext.Provider>
    );
  }

  return (
    <OpenPanelContext.Provider value={route.push}>
      <IconActionProvider>
        <ShellBandProvider>
          <ShellSlotsProvider>
            <div ref={setAppEl} className={styles.app} data-kobe-chat>
              {/* eslint-disable-next-line no-restricted-syntax -- a skip link is text by design (WCAG 2.4.1) */}
              <a className={styles.skipLink} href="#kobe-chat-main">
                Skip to the conversation
              </a>
              <UtilityBar teamId={teamId} fetchFn={fetchFn} onOpenThread={openThreadFromHeader} />
              <TeamInvites />
              {/* No active team yet: activates one (the selector itself is in the rail, KOBE-419). */}
              <TeamActivation />
              {body}
              {/* A console, My agents, Skills or a My area page over the workspace (KOBE-452). */}
              {panel !== undefined && panel.id !== "threads" ? (
                <WorkspacePanel panel={panel} path={pathname} onClose={closePanel}>
                  {route.page}
                </WorkspacePanel>
              ) : (
                route.page
              )}
            </div>
          </ShellSlotsProvider>
        </ShellBandProvider>
      </IconActionProvider>
    </OpenPanelContext.Provider>
  );
}
