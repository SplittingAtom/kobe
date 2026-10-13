"use client";

import { ThreadListItemPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { useState, type FormEvent } from "react";
import { IconAction } from "../shell/icon-action";
import styles from "./chat.module.css";

/** One thread in the rail (D16): open, rename, move to Trash; in Trash restore or delete forever. */
function ThreadItem({ archived }: { readonly archived: boolean }) {
  const aui = useAui();
  const title = useAuiState((s) => s.threadListItem.title) || "Untitled conversation";
  const [draft, setDraft] = useState<string | null>(null);

  const save = (e: FormEvent) => {
    e.preventDefault();
    const next = draft?.trim() ?? "";
    setDraft(null);
    if (next !== "" && next !== title) aui.threadListItem.rename(next);
  };

  return (
    <li>
      <ThreadListItemPrimitive.Root className={styles.threadItem}>
        {draft === null ? (
          <ThreadListItemPrimitive.Trigger className={styles.threadTrigger}>
            <ThreadListItemPrimitive.Title fallback="Untitled conversation" />
          </ThreadListItemPrimitive.Trigger>
        ) : (
          <form onSubmit={save} className={styles.search}>
            <label className={styles.visuallyHidden} htmlFor="kobe-rename">
              New title for {title}
            </label>
            <input
              id="kobe-rename"
              value={draft}
              maxLength={200}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                // Handled here: the rail's drawer (KOBE-201) must not close on the same key.
                e.preventDefault();
                setDraft(null);
              }}
            />
            <button type="submit">Save</button>
          </form>
        )}
        {draft === null && (
          <span className={styles.itemActions}>
            {!archived && (
              <IconAction
                command="rename-thread"
                label={`Rename ${title}`}
                size="sm"
                onClick={() => setDraft(title)}
              />
            )}
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
              <ThreadListItemPrimitive.Archive asChild>
                <IconAction command="trash-thread" label={`Move ${title} to Trash`} size="sm" />
              </ThreadListItemPrimitive.Archive>
            )}
          </span>
        )}
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
