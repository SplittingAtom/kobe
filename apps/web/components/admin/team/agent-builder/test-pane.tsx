"use client";

import "../../../../lib/security/zod-jitless";
import "../../../../app/chat-global.css";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useEffect, useMemo, useState } from "react";
import { createChatApi, type ChatApi } from "../../../../lib/chat/api";
import { ChatSession } from "../../../../lib/chat/session";
import type { EventSourceFactory } from "../../../../lib/chat/stream";
import { createThreadListAdapter } from "../../../../lib/chat/thread-list-adapter";
import type { ApiError } from "../../../../lib/api/client";
import { ChatSessionContext, useKobeRuntime } from "../../../chat/kobe-runtime";
import { ThreadView } from "../../../chat/thread-view";
import { ErrorNotice } from "../../error-notice";
import adminStyles from "../../admin.module.css";
import styles from "./agent-builder.module.css";

export interface AgentTestPaneProps {
  readonly teamId: string;
  readonly agentId: string;
  /** Tests inject the API transport and the event stream. */
  readonly fetchFn?: typeof fetch | undefined;
  readonly eventSource?: EventSourceFactory | undefined;
  readonly newKey?: (() => string) | undefined;
  readonly reopenDelayMs?: ((attempt: number) => number) | undefined;
}

/** One conversation with the draft: remounted (`key`) for a fresh one. */
function TestConversation({
  session: options,
  onError,
}: {
  readonly session: {
    readonly teamId: string;
    readonly api: ChatApi;
    readonly agentId: string;
  } & Pick<AgentTestPaneProps, "eventSource" | "newKey" | "reopenDelayMs">;
  readonly onError: (error: ApiError) => void;
}) {
  const { teamId, api, agentId, eventSource, newKey, reopenDelayMs } = options;
  const session = useMemo(
    () =>
      new ChatSession({ teamId, api, eventSource, newKey, reopenDelayMs, testAgentId: agentId }),
    [teamId, api, agentId, eventSource, newKey, reopenDelayMs],
  );
  useEffect(() => () => session.dispose(), [session]);
  const [threadId, setThreadId] = useState<string | undefined>();
  // The pane has no thread list: the adapter only creates and reads this one test thread.
  const adapter = useMemo(() => {
    const base = createThreadListAdapter(session, { onError });
    return { ...base, list: async () => ({ threads: [] }) };
  }, [session, onError]);
  const runtime = useKobeRuntime({ session, adapter, threadId, onThreadIdChange: setThreadId });
  return (
    <ChatSessionContext.Provider value={session}>
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadView />
      </AssistantRuntimeProvider>
    </ChatSessionContext.Provider>
  );
}

/**
 * The builder's test pane (KOBE-85): the restyled chat (#65) on the agent's saved, unpublished
 * draft. The server runs it through the normal run start (resolver, approval floor, budgets,
 * policy); its threads are flagged as test threads and never show up in the chat's lists.
 */
export function AgentTestPane({
  teamId,
  agentId,
  fetchFn,
  eventSource,
  newKey,
  reopenDelayMs,
}: AgentTestPaneProps) {
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);
  const api = useMemo(() => createChatApi(teamId, fetchFn), [teamId, fetchFn]);

  async function clear() {
    const res = await api.clearTestThreads(agentId);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setGeneration((n) => n + 1);
  }

  return (
    <div className={styles.testPane}>
      <div className={styles.toolbar}>
        <button type="button" onClick={() => setGeneration((n) => n + 1)}>
          New test chat
        </button>
        <button type="button" onClick={() => void clear()}>
          Clear test chats
        </button>
        <span className={adminStyles.hint}>
          Test chats are private to you, kept out of your conversation list, and still count toward
          budgets.
        </span>
      </div>
      {error && <ErrorNotice error={error} />}
      <div data-kobe-chat className={styles.testChat}>
        <TestConversation
          // A new key is a fresh session and conversation.
          key={generation}
          session={{ teamId, api, agentId, eventSource, newKey, reopenDelayMs }}
          onError={setError}
        />
      </div>
    </div>
  );
}
