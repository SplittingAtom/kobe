"use client";

import { ThreadListItemPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { IconAction } from "../shell/icon-action";
import { RailThreadCard } from "../shell/rail-thread-card";
import styles from "./chat.module.css";
import { ThreadRowMenu } from "./thread-row-menu";

/**
 * One thread in the rail (D16): open it; its ⋯ menu copies, regenerates or moves it to Trash
 * (KOBE-292; rename is the conversation header's pencil). In Trash: restore or delete forever.
 * Hovering or focusing the row shows its card (CE18, KOBE-219).
 */
function ThreadItem({ archived }: { readonly archived: boolean }) {
  const aui = useAui();
  const title = useAuiState((s) => s.threadListItem.title) || "Untitled conversation";
  // "Forked from …" on hover (CE16), from the list answer (`metadataOf`).
  const forkHint = useAuiState((s) => s.threadListItem.custom?.["forkHint"]);

  return (
    <li>
      <ThreadListItemPrimitive.Root className={`group/row ${styles.threadItem}`}>
        <RailThreadCard>
          <ThreadListItemPrimitive.Trigger
            className={styles.threadTrigger}
            title={typeof forkHint === "string" ? forkHint : undefined}
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
