"use client";

import { useAui, useAuiState } from "@assistant-ui/react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { modelName } from "../../lib/admin/api/team/models";
import { copyText } from "../../lib/clipboard";
import { conversationMarkdown } from "../../lib/chat/thread-copy";
import { placementOf } from "../../lib/chat/thread-groups";
import { modelChoices, teamDefaultLabel } from "../../lib/chat/model-choices";
import type { ThreadController } from "../../lib/chat/thread-controller";
import { lastAnswerPoint, regenerateBlocker } from "../../lib/chat/thread-menu";
import type { ThreadState } from "../../lib/chat/thread-state";
import { projectThread } from "../../lib/chat/tree";
import type { MenuBindings, MenuChoice } from "../../lib/shell/menu";
import { ActionMenu, ROW_REVEAL } from "../ui/action-menu";
import { useChatSession } from "./kobe-runtime";
import { useThreadTeamModels, type TeamModelsLoad } from "./use-team-models";

const NO_ANSWER = "There is no answer to regenerate yet.";
const OPENING = "Opening the conversation…";
const NOTICE_MS = 2500;
const PARTIAL = "some long answers or messages could not be included and are marked in the text.";
const NOT_YOURS = "This conversation is shared with you read-only: only its owner can delete it.";
const noopSubscribe = () => () => {};
const noState = () => undefined;

/** The thread's controller while the menu is open: its state decides what the menu offers. */
function useHeldThread(threadId: string | undefined, hold: boolean): ThreadState | undefined {
  const session = useChatSession();
  const [held, setHeld] = useState<ThreadController | null>(null);
  useEffect(() => {
    if (!hold || threadId === undefined) return;
    const controller = session.acquire(threadId);
    setHeld(controller);
    return () => {
      session.release(threadId, controller);
      setHeld(null);
    };
  }, [session, threadId, hold]);
  return useSyncExternalStore<ThreadState | undefined>(
    held?.subscribe ?? noopSubscribe,
    held?.getState ?? noState,
    held?.getState ?? noState,
  );
}

/** Resolves once the controller has read its thread (or failed to). */
function settled(controller: ThreadController): Promise<ThreadState> {
  return new Promise((resolve) => {
    const done = () => controller.getState().phase !== "loading";
    if (done()) return resolve(controller.getState());
    const stop = controller.subscribe(() => {
      if (!done()) return;
      stop();
      resolve(controller.getState());
    });
  });
}

const projectionOf = (s: ThreadState) => projectThread(s.entries, s.summary?.leafEntryId ?? null);

/** The models to regenerate with, as on the answers (KOBE-217); undefined when there is no choice. */
function choicesOf(
  loaded: TeamModelsLoad,
  state: ThreadState | undefined,
  choose: (model: string | null) => void,
): readonly MenuChoice[] | undefined {
  if (loaded.status !== "ready" || state?.summary === undefined) return undefined;
  const choices = modelChoices(loaded.data, state.summary.model ?? null, state.agentModel ?? null);
  if (choices.pinned !== null || choices.enabled.length === 0) return undefined;
  return [
    { key: "", model: null, label: teamDefaultLabel(choices) },
    ...choices.enabled.map((m) => ({ key: m.alias, model: m.alias, label: modelName(m) })),
  ].map((o) => ({
    key: o.key,
    label: o.label,
    current: o.model === choices.chosen,
    onSelect: () => choose(o.model),
  }));
}

const NOT_SENT = {
  status: 0,
  code: "client_error",
  message: "The answer could not be regenerated. Try again.",
} as const;

interface Notice {
  /** In the row. */
  readonly short: string;
  /** For screen readers. */
  readonly full: string;
}

/**
 * A listed thread's ⋯ menu in the rail (KOBE-292): Copy (the branch on screen as Markdown),
 * Regenerate and Regenerate with (its last answer, as the answer's own buttons do, after opening
 * the thread) and Delete (to Trash, confirmed). KOBE-220 binds Pin, Archive and Move here.
 */
export function ThreadRowMenu() {
  const aui = useAui();
  const session = useChatSession();
  const threadId = useAuiState((s) => s.threadListItem.remoteId);
  const title = useAuiState((s) => s.threadListItem.title) || "Untitled conversation";
  const listedShared = useAuiState((s) => placementOf(s.threadListItem.custom).shared);
  const models = useThreadTeamModels();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const state = useHeldThread(threadId, open);
  const readOnly = listedShared || state?.summary?.readOnly === true;
  const projection = useMemo(() => (state ? projectionOf(state) : undefined), [state]);
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  if (threadId === undefined) return null;

  /** Runs `act` on the thread's controller once read, held until `act` is done. */
  const withThread = <T,>(act: (c: ThreadController, s: ThreadState) => Promise<T>) => {
    const controller = session.acquire(threadId);
    return settled(controller)
      .then((s) => act(controller, s))
      .finally(() => session.release(threadId, controller));
  };

  const copy = () => {
    const copied = conversationMarkdown(session.api, threadId, title).then((res) => {
      if (!res.ok) throw new Error(res.error.message);
      return res.data;
    });
    copyText(copied.then((c) => c.markdown)).then(
      async () => {
        const { partial } = await copied;
        setNotice(
          partial
            ? {
                short: "Copied (partial)",
                full: `Copied “${title}” as Markdown, in part: ${PARTIAL}`,
              }
            : { short: "Copied", full: `Copied “${title}” as Markdown.` },
        );
      },
      () => setNotice({ short: "Not copied", full: `“${title}” could not be copied.` }),
    );
  };

  /** The answer's own paths: plain Regenerate sends again, "with" switches the model first. */
  const regenerate = (model?: string | null) => {
    void aui.threadListItem.switchTo();
    void withThread(async (c, s) => {
      const blocker = regenerateBlocker(s);
      const point = lastAnswerPoint(projectionOf(s));
      if (blocker !== null || point === undefined) {
        c.reportError({ ...NOT_SENT, message: blocker ?? NO_ANSWER });
        return;
      }
      await (model === undefined
        ? c.send(point.text, point.parentEntryId)
        : c.regenerateWith(model, point.text, point.parentEntryId));
    }).catch(() => session.peek(threadId)?.reportError(NOT_SENT));
  };

  // Undoable from Trash, so no confirm (only Delete forever asks). The list shows a refusal.
  const trash = () => {
    // Typed void, but the remote list's archive is the adapter's promise: wrap it to catch.
    Promise.resolve()
      .then(() => aui.threadListItem.archive())
      .catch(() =>
        setNotice({ short: "Not deleted", full: `“${title}” could not be moved to Trash.` }),
      );
  };

  const blocker =
    state === undefined
      ? OPENING
      : (regenerateBlocker(state) ??
        (projection && lastAnswerPoint(projection) === undefined ? NO_ANSWER : null));
  const choices = choicesOf(models, state, (model) => regenerate(model));
  // Until the thread is read, whether its agent pins the model is unknown: the item waits.
  const reading = state === undefined || state.phase === "loading";
  const bindings: MenuBindings = {
    "copy-thread": { onSelect: copy },
    "regenerate-thread": { onSelect: () => regenerate(), blocker },
    ...(choices || reading
      ? {
          "regenerate-thread-with": {
            choices: choices ?? [],
            blocker: reading ? OPENING : blocker,
          },
        }
      : {}),
    "trash-thread": { onSelect: trash, destructive: true, blocker: readOnly ? NOT_YOURS : null },
  };

  return (
    <>
      {notice && (
        <span aria-hidden className="text-muted-foreground shrink-0 text-xs">
          {notice.short}
        </span>
      )}
      <span role="status" className="sr-only">
        {notice?.full}
      </span>
      <ActionMenu
        trigger="thread-row-actions"
        label={`Actions for ${title}`}
        scope="thread-menu"
        bindings={bindings}
        onOpenChange={setOpen}
        className={ROW_REVEAL}
      />
    </>
  );
}
