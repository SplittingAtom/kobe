"use client";

import "../../lib/security/zod-jitless";
import { AssistantRuntimeProvider, Suggestions, useAui } from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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
import { rememberLastThread } from "../../lib/shell/last-thread";
import { ArtifactPanel } from "./artifact-panel";
import { AreaPanel, useAreaUrl } from "../shell/area-panel";
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
import { WorkspaceRail } from "../shell/workspace-rail";
import { FileGoneNotice } from "../files/file-tab";
import { IconActionProvider } from "../shell/icon-action";
import { InlineLink } from "../shell/text-links";
import { ShellSlot, ShellSlotsProvider, useBarMenu } from "../shell/shell-slots";
import { ThreadSearch } from "../shell/thread-search";
import { UtilityBar } from "../shell/utility-bar";
import { ChatSessionContext, useKobeRuntime } from "./kobe-runtime";
import { RetentionNotice } from "./retention-notice";
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

/** `?thread=<id>` follows the thread on screen, so a link or a refresh reopens it. */
function useThreadUrl(): readonly [string | undefined, (id: string | undefined) => void] {
  const [threadId, setThreadId] = useState<string | undefined>(threadFromUrl);
  useEffect(() => {
    const onPop = () => setThreadId(threadFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const change = useCallback((id: string | undefined) => {
    setThreadId(id);
    if (threadFromUrl() === id) return;
    const url = new URL(window.location.href);
    if (id === undefined) url.searchParams.delete(THREAD_PARAM);
    else url.searchParams.set(THREAD_PARAM, id);
    window.history.pushState(null, "", url);
  }, []);
  return [threadId, change];
}

/** Opens a thread from outside the workspace (the bell in the bar): `useThreadUrl` follows. */
function openThreadFromHeader(id: string): void {
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
function WorkspaceGrid({
  areaOpen,
  ...props
}: Omit<
  Parameters<typeof ShellGrid>[0],
  "artifactWidth" | "railWidth" | "artifactSheet" | "artifactHidden"
> & {
  /** A My area page is beside the thread (CE4): the column (or its sheet) shows it. */
  readonly areaOpen: boolean;
}) {
  const panel = useArtifactPanel();
  const rail = useRail();
  return (
    <ShellGrid
      {...props}
      artifactWidth={panel?.width ?? null}
      railWidth={rail?.width ?? null}
      artifactSheet={areaOpen || (panel?.sheetOpen ?? false)}
      artifactHidden={!areaOpen && (panel?.hidden ?? false)}
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
}: {
  readonly session: ChatSession;
  readonly activityPollMs: number | undefined;
  /** The rail's header (CE2): the workspace is the member's view of this team. */
  readonly teamName: string;
  readonly fetchFn: typeof fetch | undefined;
}) {
  const filesApi = useMemo(() => createFilesApi(session.teamId, fetchFn), [session, fetchFn]);
  const [threadId, setThreadId] = useThreadUrl();
  // A My area page beside the thread (CE4, KOBE-424): `?area=`, with Back and Forward.
  const area = useAreaUrl();
  // The consoles and builders return here, to this thread (CE4).
  useEffect(() => rememberLastThread(session.teamId, threadId), [session, threadId]);
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
  // The member's layout, from any device (CE8): loaded once, changes saved debounced.
  const layout = useLayoutPreferences(fetchFn);
  return (
    <AssistantRuntimeProvider aui={aui} runtime={runtime}>
      {/* What each action does now: the `/` menu (KOBE-224), the palette and keys (KOBE-225). */}
      <CommandBindingsProvider>
        <RetentionNotice />
        <ThreadGroupsProvider fetchFn={fetchFn}>
          <RailProvider preferences={layout.preferences} onSave={layout.save}>
            <DetailProvider preferences={layout.preferences} onSave={layout.save}>
              <ThreadUsageProvider>
                <AnswerFeedbackProvider>
                  <TeamModelsProvider>
                    <ThreadMarkersProvider>
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
                          areaOpen={area !== undefined}
                          rail={
                            <WorkspaceRail
                              teamName={teamName || "Workspace"}
                              listError={listError}
                              filesApi={filesApi}
                            />
                          }
                          artifact={
                            <>
                              <AreaPanel area={area} fetchFn={fetchFn} />
                              <ArtifactPanel filesApi={filesApi} />
                            </>
                          }
                          conversation={
                            <main id="kobe-chat-main" className={styles.main} tabIndex={-1}>
                              <ThreadView onOpenThread={setThreadId} inShell />
                            </main>
                          }
                        />
                      </ArtifactPanelProvider>
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
}: ChatAppProps) {
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
        />
      </ChatSessionContext.Provider>
    );
  }

  return (
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
          </div>
        </ShellSlotsProvider>
      </ShellBandProvider>
    </IconActionProvider>
  );
}
