"use client";

import { useCallback } from "react";
import type { ModelContext } from "../../lib/apps/bridge-schema";
import type { AppMessage } from "../../lib/apps/host-bridge";
import { NEW_DRAFT } from "../../lib/chat/attachments";
import { useChatSession, useKobeExtras } from "../chat/kobe-runtime";

/**
 * An app frame's `ui/message` and `ui/update-model-context` (KOBE-439, spec §8): the text goes to
 * the composer of the card's own thread (keyed by thread id), never sent, never moving the focus;
 * resource_links in the message become that thread's item chips instead of the text (KOBE-490).
 * The context becomes that thread's chip for this app (last write wins), sent only with the
 * member's next message there.
 *
 * A rail picker (KOBE-460) has no thread of its own: it uses the conversation on screen, and
 * with `newConversation` the new-conversation draft when none is (its chip goes with that
 * conversation's first message). `active: false` refuses both (the picker is not on screen).
 */
export function useAppComposer(
  app: {
    readonly appId: string;
    readonly connectorId: string;
    readonly templateSha256: string;
    readonly title: string;
  },
  options: { readonly newConversation?: boolean; readonly active?: boolean } = {},
) {
  const session = useChatSession();
  const onScreen = useKobeExtras()?.state.threadId ?? null;
  const threadId =
    options.active === false ? null : (onScreen ?? (options.newConversation ? NEW_DRAFT : null));
  const { appId, connectorId, templateSha256, title } = app;
  const onMessage = useCallback(
    ({ text, items, dropped }: AppMessage) => {
      if (threadId === null) return false;
      // Items become chips in the thread's chip row and replace the text (KOBE-490).
      if (items.length > 0) {
        return session.appItems.add(
          threadId,
          items.map((item) => ({ ...item, from: title })),
        );
      }
      if (text !== "") return session.composerInserts.request(threadId, text, title);
      if (dropped > 0) session.appItems.refused(threadId, title);
      return false;
    },
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
