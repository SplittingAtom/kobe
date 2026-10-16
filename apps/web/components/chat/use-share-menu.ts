"use client";

import { useContext } from "react";
import { placementOf } from "../../lib/chat/thread-groups";
import { SHARE_LABELS, sharedMessage, visibilityOf } from "../../lib/chat/share";
import type { ThreadState } from "../../lib/chat/thread-state";
import type { ThreadVisibility } from "../../lib/chat/types";
import type { MenuBindings, MenuChoice } from "../../lib/shell/menu";
import { useChatSession } from "./kobe-runtime";
import { RailAnnounce } from "./use-organize-menu";

/**
 * Share in a thread row's menu (CE20, KOBE-221): a submenu of who may read the thread, the current
 * scope marked; "Only you" revokes. The project scope is offered only for a thread in a project.
 * A reader's row says why it can't. The server decides; a refusal is announced and shown.
 */

const NOT_YOURS = "This conversation is shared with you read-only: only its owner can share it.";

export interface ShareMenuInput {
  readonly threadId: string;
  readonly title: string;
  readonly custom: unknown;
  readonly readOnly: boolean;
  readonly state: ThreadState | undefined;
  readonly notify: (notice: { readonly short: string; readonly full: string }) => void;
}

export function useShareMenu(input: ShareMenuInput): MenuBindings {
  const session = useChatSession();
  const announce = useContext(RailAnnounce);
  const { threadId, title, readOnly, state, notify } = input;
  if (readOnly) return { "share-thread": { blocker: NOT_YOURS } };
  const placement = placementOf(input.custom);
  const summary = state?.summary;
  const projectId = summary ? summary.projectId : placement.projectId;
  const current = summary ? visibilityOf(summary) : placement.visibility;

  const apply = (visibility: ThreadVisibility) => {
    void session.share(threadId, visibility).then(
      (res) => {
        if (res.ok) {
          announce(sharedMessage(title, visibility));
          return;
        }
        notify({ short: "Not shared", full: res.error.message });
        announce(res.error.message);
      },
      () => notify({ short: "Not shared", full: `“${title}” was not changed.` }),
    );
  };
  const scopes: readonly ThreadVisibility[] =
    projectId === null ? ["private", "team"] : ["private", "project", "team"];
  const choices: readonly MenuChoice[] = scopes.map((v) => ({
    key: v,
    label: SHARE_LABELS[v],
    current: v === current,
    onSelect: () => apply(v),
  }));
  return { "share-thread": { choices } };
}
