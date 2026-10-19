"use client";

import { useAui } from "@assistant-ui/react";
import { useMemo } from "react";
import { modelName } from "../../lib/admin/api/team/models";
import { copyText } from "../../lib/clipboard";
import { conversationMarkdown } from "../../lib/chat/thread-copy";
import { modelChoices, teamDefaultLabel } from "../../lib/chat/model-choices";
import type { ThreadController } from "../../lib/chat/thread-controller";
import { lastAnswerPoint, regenerateBlocker } from "../../lib/chat/thread-menu";
import type { ThreadState } from "../../lib/chat/thread-state";
import { projectThread } from "../../lib/chat/tree";
import type { MenuBindings, MenuChoice } from "../../lib/shell/menu";
import { useChatSession } from "./kobe-runtime";
import { useThreadTeamModels, type TeamModelsLoad } from "./use-team-models";
import { useOrganizeMenu } from "./use-organize-menu";
import { useShareMenu } from "./use-share-menu";
import { useSkillMenu } from "./use-skill-menu";

const NO_ANSWER = "There is no answer to regenerate yet.";
export const OPENING = "Opening the conversation…";
const PARTIAL = "some long answers or messages could not be included and are marked in the text.";
const NOT_YOURS = "This conversation is shared with you read-only: only its owner can delete it.";

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

export interface Notice {
  /** Shown beside the menu button. */
  readonly short: string;
  /** For screen readers. */
  readonly full: string;
}

export interface ThreadMenuInput {
  /** The thread (its list item's remote id); undefined for a draft. */
  readonly threadId: string | undefined;
  readonly title: string;
  /** The list item's `custom` (`placementCustom`). */
  readonly custom: unknown;
  /** The menu (or a listing of actions) is open: Move reads the projects. */
  readonly open: boolean;
  readonly readOnly: boolean;
  /** The thread's state, once read. */
  readonly state: ThreadState | undefined;
  readonly notify: (notice: Notice) => void;
}

/**
 * What a thread's menu does (KOBE-292), for the thread under the current `threadListItem`: Copy
 * (the branch on screen as Markdown), Regenerate and Regenerate with (its last answer, as the
 * answer's own buttons do, after opening the thread), Pin, Move to project and Archive (CE19,
 * KOBE-220), Share (CE20, KOBE-221), the skill actions (KOBE-322) and Delete (to Trash, no
 * confirm: it can be undone). The rail
 * row's ⋯ menu shows them; the open thread publishes the same bindings to the `/` menu (KOBE-224).
 */
export function useThreadMenuBindings(input: ThreadMenuInput): MenuBindings {
  const aui = useAui();
  const session = useChatSession();
  const models = useThreadTeamModels();
  const { threadId, title, custom, open, readOnly, state, notify } = input;
  const projection = useMemo(() => (state ? projectionOf(state) : undefined), [state]);
  const organize = useOrganizeMenu({
    threadId: threadId ?? "",
    title,
    custom,
    open,
    readOnly,
    state,
    notify,
  });
  const share = useShareMenu({ threadId: threadId ?? "", title, custom, readOnly, state, notify });
  const skills = useSkillMenu({ threadId, title, open, notify });
  if (threadId === undefined) return {};

  /** Runs `act` on the thread's controller once read, held until `act` is done. */
  const withThread = <T>(act: (c: ThreadController, s: ThreadState) => Promise<T>) => {
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
        notify(
          partial
            ? {
                short: "Copied (partial)",
                full: `Copied “${title}” as Markdown, in part: ${PARTIAL}`,
              }
            : { short: "Copied", full: `Copied “${title}” as Markdown.` },
        );
      },
      () => notify({ short: "Not copied", full: `“${title}” could not be copied.` }),
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
        notify({ short: "Not deleted", full: `“${title}” could not be moved to Trash.` }),
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
  return {
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
    ...organize,
    ...share,
    ...skills,
    "trash-thread": { onSelect: trash, destructive: true, blocker: readOnly ? NOT_YOURS : null },
  };
}
