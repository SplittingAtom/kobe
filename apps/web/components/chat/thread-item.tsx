"use client";

import { ThreadListItemPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { useId } from "react";
import { SHARED_THREAD_DRAG_TYPE, THREAD_DRAG_TYPE } from "../../lib/chat/organize";
import { useHitNote } from "./hit-note";
import { placementOf } from "../../lib/chat/thread-groups";
import { IconAction } from "../shell/icon-action";
import { RailThreadCard } from "../shell/rail-thread-card";
import styles from "./chat.module.css";
import { ThreadActivityDot, useRowActivity, useRowUnread } from "./thread-activity";
import { ThreadRowMenu } from "./thread-row-menu";

/**
 * One thread in the rail (D16): open it; its ⋯ menu copies, regenerates, pins, moves, archives or
 * moves it to Trash (KOBE-292, KOBE-220; rename is the conversation header's pencil), and a trash
 * icon on hover or focus moves it there too (KOBE-466). In Trash:
 * restore or delete forever. Hovering or focusing the row shows its card (CE18, KOBE-219). The
 * member's own rows can be dragged onto a project header to move there (CE19), and any row onto a
 * folder in the Threads panel's tree to file it there (KOBE-536, TF8).
 */
function ThreadItem({ archived }: { readonly archived: boolean }) {
  const aui = useAui();
  const title = useAuiState((s) => s.threadListItem.title) || "Untitled conversation";
  // "Forked from …" on hover (CE16), from the list answer (`metadataOf`).
  const forkHint = useAuiState((s) => s.threadListItem.custom?.["forkHint"]);
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const shared = useAuiState((s) => placementOf(s.threadListItem.custom).shared);
  // Own rows drag onto a project header or a folder; shared ones onto a folder only (TF8).
  const movable = !archived && remoteId !== undefined;
  // A run going or an approval waiting, live, also while another thread is open (KOBE-301).
  const activity = useRowActivity();
  const unread = useRowUnread();
  const described = activity !== "idle" || unread;
  const activityId = useId();
  // In the Threads panel's search (KOBE-453): where this thread matched.
  const hitNote = useHitNote(remoteId);

  return (
    <li
      data-kobe-thread={remoteId}
      draggable={movable || undefined}
      onDragStart={
        movable
          ? (e) => {
              e.dataTransfer.setData(THREAD_DRAG_TYPE, remoteId);
              if (shared) e.dataTransfer.setData(SHARED_THREAD_DRAG_TYPE, remoteId);
              e.dataTransfer.effectAllowed = "move";
            }
          : undefined
      }
    >
      <ThreadListItemPrimitive.Root
        className={`group/row ${styles.threadItem}`}
        data-kobe-activity={activity}
      >
        <ThreadActivityDot activity={activity} id={activityId} unread={unread} />
        <RailThreadCard>
          <ThreadListItemPrimitive.Trigger
            className={styles.threadTrigger}
            title={typeof forkHint === "string" ? forkHint : undefined}
            aria-describedby={described ? activityId : undefined}
          >
            <ThreadListItemPrimitive.Title fallback="Untitled conversation" />
          </ThreadListItemPrimitive.Trigger>
        </RailThreadCard>
        <span className={styles.itemActions}>
          {archived ? (
            <>
              <ThreadListItemPrimitive.Unarchive asChild>
                <IconAction command="restore-thread" label={`Restore ${title}`} size="sm" />
              </ThreadListItemPrimitive.Unarchive>
              <IconAction
                command="delete-thread"
                label={`Delete ${title} forever`}
                size="sm"
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete “${title}” forever? Its messages, files and history can't be recovered.`,
                    )
                  ) {
                    void aui.threadListItem.delete();
                  }
                }}
              />
            </>
          ) : (
            <ThreadRowMenu />
          )}
        </span>
      </ThreadListItemPrimitive.Root>
      {hitNote}
    </li>
  );
}

function ListedThreadItem() {
  return <ThreadItem archived={false} />;
}

function TrashThreadItem() {
  return <ThreadItem archived />;
}

/** For `ThreadListPrimitive.ItemByIndex` (module constants: it re-renders on a new object). */
export const THREAD_ITEM = { ThreadListItem: ListedThreadItem } as const;
export const TRASH_ITEM = { ThreadListItem: TrashThreadItem } as const;
