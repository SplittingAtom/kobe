"use client";

import "../../lib/security/zod-jitless";
import "../../app/chat-global.css";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useEffect, useMemo, useState } from "react";
import type { ApiError } from "../../lib/api/client";
import { createChatApi, type ChatApi } from "../../lib/chat/api";
import { ChatSession } from "../../lib/chat/session";
import type { EventSourceFactory } from "../../lib/chat/stream";
import { createThreadListAdapter } from "../../lib/chat/thread-list-adapter";
import { ChatSessionContext, useKobeRuntime } from "../chat/kobe-runtime";
import { ThreadView } from "../chat/thread-view";
import { IconActionProvider } from "../shell/icon-action";
import { Button } from "../ui/console";
import { ErrorNotice } from "../admin/error-notice";

export interface SkillTestPaneProps {
  readonly teamId: string;
  readonly draftId: string;
  /** Writes the editor's pending edits: every message tests the draft as it is now. */
  readonly flush: () => Promise<unknown>;
  /** Tests inject the API transport and the event stream. */
  readonly fetchFn?: typeof fetch | undefined;
  readonly eventSource?: EventSourceFactory | undefined;
  readonly newKey?: (() => string) | undefined;
}

/** One test chat: remounted (`key`) for a fresh one. */
function TestChat({
  teamId,
  api,
  draftId,
  eventSource,
  newKey,
  onError,
}: {
  readonly teamId: string;
  readonly api: ChatApi;
  readonly draftId: string;
  readonly eventSource?: EventSourceFactory | undefined;
  readonly newKey?: (() => string) | undefined;
  readonly onError: (error: ApiError) => void;
}) {
  const session = useMemo(
    () => new ChatSession({ teamId, api, eventSource, newKey, testSkillDraftId: draftId }),
    [teamId, api, draftId, eventSource, newKey],
  );
  useEffect(() => () => session.dispose(), [session]);
  const [threadId, setThreadId] = useState<string | undefined>();
  // The pane shows one chat; its threads are listed in the chat's Workbench group.
  const adapter = useMemo(() => {
    const base = createThreadListAdapter(session, { onError });
    return { ...base, list: async () => ({ threads: [] }) };
  }, [session, onError]);
  const runtime = useKobeRuntime({ session, adapter, threadId, onThreadIdChange: setThreadId });
  return (
    <ChatSessionContext.Provider value={session}>
      <AssistantRuntimeProvider runtime={runtime}>
        <IconActionProvider>
          <ThreadView />
        </IconActionProvider>
      </AssistantRuntimeProvider>
    </ChatSessionContext.Provider>
  );
}

/**
 * The Workbench test pane (KOBE-323, SK13): a chat with the Kobe agent that loads only this draft
 * as it is now (pending edits are saved before each message, and the server scans it before the
 * run). It runs in the member's own workspace under the team's policy, egress and budgets, and the
 * Used-skill badge shows when the draft was used. Test chats are ordinary conversations, kept in
 * the chat's Workbench group under the team's retention.
 */
export function SkillTestPane({
  teamId,
  draftId,
  flush,
  fetchFn,
  eventSource,
  newKey,
}: SkillTestPaneProps) {
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);
  const api = useMemo((): ChatApi => {
    const base = createChatApi(teamId, fetchFn);
    return {
      ...base,
      sendMessage: async (...args) => {
        await flush();
        return base.sendMessage(...args);
      },
    };
  }, [teamId, fetchFn, flush]);

  return (
    <section aria-labelledby="skill-test-heading" className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 id="skill-test-heading" className="m-0 text-base font-semibold">
          Test
        </h2>
        <Button size="sm" onClick={() => setGeneration((n) => n + 1)}>
          New test chat
        </Button>
      </div>
      <p className="m-0 mb-2 text-sm text-console-muted">
        Only this draft is loaded, as it is now. Test chats are kept in the chat&apos;s Workbench
        group and count toward budgets.
      </p>
      {error && <ErrorNotice error={error} />}
      <div
        data-kobe-chat
        className="box-border flex h-[34rem] max-h-[80vh] flex-col overflow-hidden rounded-lg border border-console-border"
      >
        <TestChat
          key={generation}
          teamId={teamId}
          api={api}
          draftId={draftId}
          eventSource={eventSource}
          newKey={newKey}
          onError={setError}
        />
      </div>
    </section>
  );
}
