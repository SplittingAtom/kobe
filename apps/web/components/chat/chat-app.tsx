"use client";

import "../../lib/security/zod-jitless";
import { AssistantRuntimeProvider, Suggestions, useAui } from "@assistant-ui/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { TeamInvites } from "../../app/team-invites";
import { TeamSwitcher } from "../../app/team-switcher";
import type { ApiError } from "../../lib/api/client";
import { createChatApi } from "../../lib/chat/api";
import { ChatSession } from "../../lib/chat/session";
import type { EventSourceFactory } from "../../lib/chat/stream";
import type { UploadTransport } from "../../lib/chat/uploads";
import { createThreadListAdapter } from "../../lib/chat/thread-list-adapter";
import { ACTIVE_TEAM_EVENT, fetchMyTeams } from "../../lib/teams";
import { createFilesApi } from "../../lib/files/api";
import { ConsoleLinks } from "../admin/console-links";
import { ArtifactPanel, ArtifactPanelProvider } from "./artifact-panel";
import { FilesPanel, FilesPanelProvider } from "../files/files-panel";
import { ChatSessionContext, useKobeRuntime } from "./kobe-runtime";
import { RetentionNotice } from "./retention-notice";
import { ThreadSidebar } from "./thread-sidebar";
import { ThreadView } from "./thread-view";
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

type TeamState =
  | { readonly status: "loading" }
  | { readonly status: "signedOut" }
  | { readonly status: "noTeam" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly teamId: string };

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
        else if (my.activeTeamId === null) setState({ status: "noTeam" });
        else setState({ status: "ready", teamId: my.activeTeamId });
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
  fetchFn,
}: {
  readonly session: ChatSession;
  readonly fetchFn: typeof fetch | undefined;
}) {
  const filesApi = useMemo(() => createFilesApi(session.teamId, fetchFn), [session, fetchFn]);
  const [threadId, setThreadId] = useThreadUrl();
  const [listError, setListError] = useState<ApiError | null>(null);
  const adapter = useMemo(
    () => createThreadListAdapter(session, { onError: setListError }),
    [session],
  );
  const runtime = useKobeRuntime({ session, adapter, threadId, onThreadIdChange: setThreadId });
  // A thread created by its first message: read the list again for its title.
  useEffect(() => session.onThreadCreated(() => void runtime.threads.reload()), [session, runtime]);
  const aui = useAui({ suggestions: Suggestions(STARTER_SUGGESTIONS) });
  return (
    <AssistantRuntimeProvider aui={aui} runtime={runtime}>
      <RetentionNotice />
      <FilesPanelProvider scope={session.teamId}>
        <ArtifactPanelProvider scope={`${session.teamId}:${threadId ?? ""}`}>
          <div className={styles.body}>
            <ThreadSidebar listError={listError} onOpenThread={setThreadId} />
            <main id="kobe-chat-main" className={styles.main} tabIndex={-1}>
              <ThreadView />
            </main>
            <div className={styles.sidePanels}>
              <ArtifactPanel className={styles.sidePanel} />
              <FilesPanel api={filesApi} className={styles.sidePanel} />
            </div>
          </div>
        </ArtifactPanelProvider>
      </FilesPanelProvider>
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
}

/**
 * The chat app (KOBE-32): team switcher and console links on top, the thread list on the left,
 * the conversation on the right. Everything goes through the server's APIs with the session
 * cookie from this browser; nothing is fetched or cached on the Next.js server.
 */
export function ChatApp({
  fetchFn,
  eventSource,
  newKey,
  reopenDelayMs,
  uploadTransport,
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
          }),
    [teamId, fetchFn, eventSource, newKey, reopenDelayMs, uploadTransport],
  );
  useEffect(() => () => session?.dispose(), [session]);

  let body: ReactNode;
  if (team.status === "loading")
    body = (
      <p className={styles.empty} role="status">
        Loading…
      </p>
    );
  else if (team.status === "signedOut") {
    body = (
      <p className={styles.empty}>
        <Link href="/sign-in">Sign in</Link> to chat with your agents.
      </p>
    );
  } else if (team.status === "noTeam") {
    body = <p className={styles.empty}>Choose a team with the team switcher to start chatting.</p>;
  } else if (team.status === "error") {
    body = (
      <p className={styles.empty} role="alert">
        {team.message}
      </p>
    );
  } else if (session) {
    body = (
      <ChatSessionContext.Provider value={session}>
        <ChatWorkspace key={session.teamId} session={session} fetchFn={fetchFn} />
      </ChatSessionContext.Provider>
    );
  }

  return (
    <div className={styles.app} data-kobe-chat>
      <a className={styles.skipLink} href="#kobe-chat-main">
        Skip to the conversation
      </a>
      <header className={styles.header}>
        <h1 className={styles.brand}>Kobe</h1>
        <TeamSwitcher />
        <nav aria-label="My area">
          <Link href="/me/agents">My agents</Link> <Link href="/me/skills">My skills</Link> <Link href="/me/memory">My memory</Link>
        </nav>
        <ConsoleLinks />
      </header>
      <TeamInvites />
      {body}
    </div>
  );
}
