"use client";

import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import { useState, type FormEvent } from "react";
import type { ApiError } from "../../lib/api/client";
import type { ThreadSearchHit } from "../../lib/chat/types";
import { ErrorNotice } from "../admin/error-notice";
import { useChatSession } from "./kobe-runtime";
import styles from "./chat.module.css";

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
              <ThreadListItemPrimitive.Unarchive
                className={styles.iconButton}
                aria-label={`Restore ${title}`}
              >
                Restore
              </ThreadListItemPrimitive.Unarchive>
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

function SearchResults({
  hits,
  onOpen,
}: {
  readonly hits: readonly ThreadSearchHit[];
  readonly onOpen: (threadId: string) => void;
}) {
  if (hits.length === 0) return <p className={styles.hint}>No conversations match.</p>;
  return (
    <ul className={styles.threadList} aria-label="Search results">
      {hits.map((hit) => (
        <li key={hit.threadId}>
          <button
            type="button"
            className={styles.threadTrigger}
            onClick={() => onOpen(hit.threadId)}
          >
            {hit.title ?? "Untitled conversation"}
          </button>
          {hit.snippet && (
            <p className={styles.hit}>
              {hit.snippet.map((segment, i) =>
                segment.highlight ? (
                  <mark key={i}>{segment.text}</mark>
                ) : (
                  <span key={i}>{segment.text}</span>
                ),
              )}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

type SearchState =
  | { readonly status: "idle" }
  | { readonly status: "searching"; readonly q: string }
  | { readonly status: "done"; readonly q: string; readonly hits: readonly ThreadSearchHit[] }
  | { readonly status: "error"; readonly q: string; readonly error: ApiError };

/** Thread list (D16 RemoteThreadListAdapter), search (KOBE-33 `?q=`) and Trash (D18). */
export function ThreadSidebar({
  listError,
  onOpenThread,
}: {
  readonly listError: ApiError | null;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const session = useChatSession();
  const [view, setView] = useState<"threads" | "trash">("threads");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchState>({ status: "idle" });
  const [folded, setFolded] = useState(true);
  const hasMore = useAuiState((s) => s.threads.hasMore);

  const runSearch = async (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (q === "") {
      setSearch({ status: "idle" });
      return;
    }
    setSearch({ status: "searching", q });
    const res = await session.api.searchThreads(q);
    setSearch(
      res.ok
        ? { status: "done", q, hits: res.data.threads }
        : { status: "error", q, error: res.error },
    );
  };

  const clearSearch = () => {
    setQuery("");
    setSearch({ status: "idle" });
  };

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
          <form role="search" className={styles.search} onSubmit={(e) => void runSearch(e)}>
            <label className={styles.visuallyHidden} htmlFor="kobe-search">
              Search conversations
            </label>
            <input
              id="kobe-search"
              type="search"
              value={query}
              maxLength={256}
              placeholder="Search conversations"
              onChange={(e) => setQuery(e.target.value)}
            />
            <button type="submit">Search</button>
          </form>
          {listError && <ErrorNotice error={listError} />}
          {search.status !== "idle" ? (
            <section aria-label={`Results for ${search.q}`}>
              <p className={styles.hint} role="status">
                {search.status === "searching" ? "Searching…" : `Results for “${search.q}”`}{" "}
                <button type="button" onClick={clearSearch}>
                  Clear
                </button>
              </p>
              {search.status === "error" && <ErrorNotice error={search.error} />}
              {search.status === "done" && (
                <SearchResults
                  hits={search.hits}
                  onOpen={(id) => {
                    setFolded(true);
                    onOpenThread(id);
                  }}
                />
              )}
            </section>
          ) : (
            <>
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
                  aria-pressed={view === "trash"}
                  onClick={() => setView("trash")}
                >
                  Trash
                </button>
              </div>
              {view === "trash" && (
                <p className={styles.hint}>
                  Conversations in Trash are deleted for good after 30 days.
                </p>
              )}
              <ul
                className={styles.threadList}
                aria-label={view === "trash" ? "Trash" : "Your conversations"}
              >
                <ThreadListPrimitive.Items archived={view === "trash"}>
                  {() => <ThreadItem archived={view === "trash"} />}
                </ThreadListPrimitive.Items>
              </ul>
              {view === "threads" && hasMore && (
                <ThreadListPrimitive.LoadMore>Load more</ThreadListPrimitive.LoadMore>
              )}
            </>
          )}
        </ThreadListPrimitive.Root>
      </div>
    </aside>
  );
}
