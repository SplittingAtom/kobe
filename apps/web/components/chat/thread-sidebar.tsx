"use client";

import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import { useState, type FormEvent } from "react";
import type { ApiError } from "../../lib/api/client";
import { threadExportUrl } from "../../lib/chat/api";
import { ErrorNotice } from "../admin/error-notice";
import { useChatSession } from "./kobe-runtime";
import styles from "./chat.module.css";

type View = "threads" | "scheduled" | "trash";

function ThreadItem({ archived, view }: { readonly archived: boolean; readonly view: View }) {
  const aui = useAui();
  const session = useChatSession();
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const title = useAuiState((s) => s.threadListItem.title) || "Untitled conversation";
  const [draft, setDraft] = useState<string | null>(null);

  const save = (e: FormEvent) => {
    e.preventDefault();
    const next = draft?.trim() ?? "";
    setDraft(null);
    if (next !== "" && next !== title) aui.threadListItem.rename(next);
  };

  // Schedule threads live in the Scheduled folder, not among the conversations (Trash shows all).
  if (!archived && session.isScheduled(remoteId) !== (view === "scheduled")) return null;

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
                if (e.key === "Escape") setDraft(null);
              }}
            />
            <button type="submit">Save</button>
          </form>
        )}
        {draft === null && (
          <span className={styles.itemActions}>
            {!archived && (
              <button
                type="button"
                className={styles.iconButton}
                aria-label={`Rename ${title}`}
                onClick={() => setDraft(title)}
              >
                Rename
              </button>
            )}
            {archived ? (
              <>
                <ThreadListItemPrimitive.Unarchive
                  className={styles.iconButton}
                  aria-label={`Restore ${title}`}
                >
                  Restore
                </ThreadListItemPrimitive.Unarchive>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label={`Delete ${title} forever`}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Delete “${title}” forever? Its messages, files and history can't be recovered.`,
                      )
                    ) {
                      void aui.threadListItem.delete();
                    }
                  }}
                >
                  Delete forever
                </button>
              </>
            ) : (
              <ThreadListItemPrimitive.Archive
                className={styles.iconButton}
                aria-label={`Move ${title} to Trash`}
              >
                Trash
              </ThreadListItemPrimitive.Archive>
            )}
          </span>
        )}
      </ThreadListItemPrimitive.Root>
    </li>
  );
}

/** Thread list (D16 RemoteThreadListAdapter) and Trash (D18); search moved to the bar (KOBE-197). */
export function ThreadSidebar({ listError }: { readonly listError: ApiError | null }) {
  const session = useChatSession();
  const [view, setView] = useState<View>("threads");
  const [folded, setFolded] = useState(true);
  const hasMore = useAuiState((s) => s.threads.hasMore);
  // On narrow screens the open list folds once a thread is on screen, however it was opened (the
  // list, New, a search hit in the bar, the bell).
  const threadId = useAuiState((s) => s.threadListItem.id);
  const [seenThread, setSeenThread] = useState(threadId);
  if (seenThread !== threadId) {
    setSeenThread(threadId);
    setFolded(true);
  }

  return (
    <aside
      className={`${styles.sidebar} ${folded ? styles.sidebarFolded : ""}`}
      aria-label="Conversations"
    >
      <button
        type="button"
        className={styles.sidebarToggle}
        aria-expanded={!folded}
        aria-controls="kobe-sidebar-body"
        onClick={() => setFolded((f) => !f)}
      >
        {folded ? "Show conversations" : "Hide conversations"}
      </button>
      <div id="kobe-sidebar-body" className={styles.sidebarBody}>
        <ThreadListPrimitive.Root>
          <ThreadListPrimitive.New onClick={() => setFolded(true)}>
            New conversation
          </ThreadListPrimitive.New>
          {listError && <ErrorNotice error={listError} />}
          <div className={styles.tabs} role="group" aria-label="Show">
            <button
              type="button"
              aria-pressed={view === "threads"}
              onClick={() => setView("threads")}
            >
              Conversations
            </button>
            <button
              type="button"
              aria-pressed={view === "scheduled"}
              onClick={() => setView("scheduled")}
            >
              Scheduled
            </button>
            <button type="button" aria-pressed={view === "trash"} onClick={() => setView("trash")}>
              Trash
            </button>
          </div>
          {view === "scheduled" && (
            <p className={styles.hint}>
              Conversations your <a href="/me/schedules">schedules</a> started.
            </p>
          )}
          {view === "trash" && (
            <p className={styles.hint}>
              Conversations in Trash are deleted for good after 30 days.
            </p>
          )}
          <ul
            className={styles.threadList}
            aria-label={
              view === "trash" ? "Trash" : view === "scheduled" ? "Scheduled" : "Your conversations"
            }
          >
            <ThreadListPrimitive.Items archived={view === "trash"}>
              {() => <ThreadItem archived={view === "trash"} view={view} />}
            </ThreadListPrimitive.Items>
          </ul>
          {view !== "trash" && hasMore && (
            <ThreadListPrimitive.LoadMore>Load more</ThreadListPrimitive.LoadMore>
          )}
          <p className={styles.hint}>
            <a href={threadExportUrl(session.teamId)} download>
              Export my conversations
            </a>{" "}
            (this team&apos;s, as Pi sessions and Markdown in a zip)
          </p>
        </ThreadListPrimitive.Root>
      </div>
    </aside>
  );
}
