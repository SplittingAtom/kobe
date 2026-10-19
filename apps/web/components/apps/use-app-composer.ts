"use client";

import { useCallback } from "react";
import type { ModelContext } from "../../lib/apps/bridge-schema";
import { useChatSession, useKobeExtras } from "../chat/kobe-runtime";

/**
 * An app frame's `ui/message` and `ui/update-model-context` (KOBE-439, spec §8): the text goes to
 * the composer of the card's own thread (keyed by thread id), never sent, never moving the focus; the context becomes that thread's chip for this app (last write
 * wins), sent only with the member's next message there.
 */
export function useAppComposer(app: {
  readonly appId: string;
  readonly connectorId: string;
  readonly templateSha256: string;
  readonly title: string;
}) {
  const session = useChatSession();
  const threadId = useKobeExtras()?.state.threadId ?? null;
  const { appId, connectorId, templateSha256, title } = app;
  const onMessage = useCallback(
    (text: string) => threadId !== null && session.composerInserts.request(threadId, text, title),
    [session, threadId, title],
  );
  const onModelContext = useCallback(
    (context: ModelContext) =>
      threadId !== null &&
      session.appContexts.set(threadId, {
        appId,
        connectorId,
        templateSha256,
        title,
        data: {
          ...(context.content === undefined ? {} : { content: context.content }),
          ...(context.structuredContent === undefined
            ? {}
            : { structuredContent: context.structuredContent }),
        },
      }),
    [session, threadId, appId, connectorId, templateSha256, title],
  );
  return { onMessage, onModelContext };
}
