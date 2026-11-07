"use client";

import { useCallback, useMemo } from "react";
import type { ModelContext } from "../../lib/apps/bridge-schema";
import { frameDragRelay } from "../../lib/apps/frame-drag";
import type { AppMessage, BridgeDragEvent } from "../../lib/apps/host-bridge";
import { NEW_DRAFT } from "../../lib/chat/attachments";
import type { ChatSession } from "../../lib/chat/session";
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
 *
 * A pointer drag out of the frame (KOBE-553) goes to the session's `frameDrag` with the app's
 * title as `from`; the composer on screen takes the drop. A frame with no composer starts none.
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
      return applyAppMessage(session, threadId, { text, items, dropped }, title);
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
  const relay = useMemo(() => frameDragRelay(session.frameDrag), [session]);
  const onDrag = useCallback(
    (event: BridgeDragEvent) => relay(event, threadId === null ? null : title),
    [relay, threadId, title],
  );
  return { onMessage, onModelContext, onDrag };
}

/**
 * A `ui/message` (as `appMessageOf` reads it) into the composer of `draft`: its items as chips,
 * which replace the text (KOBE-490), else its text at the caret. False when the composer took
 * nothing. Also how a dropped Lakehouse Picker item gets its chip (KOBE-551).
 */
export function applyAppMessage(
  session: ChatSession,
  draft: string,
  { text, items, dropped }: AppMessage,
  from: string,
): boolean {
  if (items.length > 0) {
    return session.appItems.add(
      draft,
      items.map((item) => ({ ...item, from })),
    );
  }
  if (text !== "") return session.composerInserts.request(draft, text, from);
  if (dropped > 0) session.appItems.refused(draft, from);
  return false;
}
