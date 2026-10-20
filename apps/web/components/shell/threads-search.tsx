"use client";

import { ThreadListPrimitive, useAuiState } from "@assistant-ui/react";
import { useEffect, useState, type ReactNode } from "react";
import type { ApiError } from "../../lib/api/client";
import type { ThreadSearchHit } from "../../lib/chat/types";
import { ErrorNotice } from "../admin/error-notice";
import { HitNotes } from "../chat/hit-note";
import { useChatSession } from "../chat/kobe-runtime";
import { THREAD_ITEM, TRASH_ITEM } from "../chat/thread-item";
import chat from "../chat/chat.module.css";
import shell from "./shell.module.css";

/** How long the Threads panel waits after the last key before it asks the server. */
export const SEARCH_DEBOUNCE_MS = 250;

type SearchState =
  | { readonly status: "idle" }
  | { readonly status: "searching"; readonly q: string }
  | {
      readonly status: "done";
      readonly q: string;
      readonly hits: readonly ThreadSearchHit[];
      readonly next: string | null;
    }
  | { readonly status: "error"; readonly q: string; readonly error: ApiError };

/**
 * The server's thread search (U15: Postgres over titles and content, `GET /v1/threads?q=`, as the
 * bar's search), for the Threads panel (KOBE-453): asked a moment after the last key, the older
 * request aborted, so only the newest query's answer shows. `more` reads the next page.
 */
export function useThreadsSearch(query: string): {
  readonly state: SearchState;
  more(): void;
} {
  const session = useChatSession();
  const q = query.trim();
  const [state, setState] = useState<SearchState>({ status: "idle" });
  useEffect(() => {
    if (q === "") {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "searching", q });
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void session.api.searchThreads(q, undefined, abort.signal).then((res) => {
        if (abort.signal.aborted) return;
        setState(
          res.ok
            ? { status: "done", q, hits: res.data.threads, next: res.data.nextCursor }
            : { status: "error", q, error: res.error },
        );
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [q, session]);
  const more = () => {
    if (state.status !== "done" || state.next === null) return;
    const { hits, next } = state;
    void session.api.searchThreads(state.q, next).then((res) => {
      if (!res.ok) return;
      setState((cur) =>
        cur.status === "done" && cur.q === q
          ? { ...cur, hits: [...hits, ...res.data.threads], next: res.data.nextCursor }
          : cur,
      );
    });
  };
  return { state, more };
}

function note(hit: ThreadSearchHit): ReactNode {
  return (
    <>
      {/* Archived threads stay searchable (CE19), marked so the member knows where they live. */}
      {hit.archivedAt != null && (
        <span className={shell.hitBadge} data-kobe-archived="">
          Archived
        </span>
      )}
      {hit.snippet && (
        <p className={shell.snippet}>
          {hit.snippet.map((segment, i) =>
            segment.highlight ? (
              <mark key={i}>{segment.text}</mark>
            ) : (
              <span key={i}>{segment.text}</span>
            ),
          )}
        </p>
      )}
    </>
  );
}

/**
 * The search's hits as thread rows (KOBE-453): a thread the list holds is its own row, with the same
 * menu, keyboard access, dot and drag; one the list has not read yet (further down, `Load more`)
 * is a plain row that opens it. Under each, where it matched.
 */
export function SearchHits({ state, more }: { readonly state: SearchState; more(): void }) {
  const items = useAuiState((s) => s.threads.threadItems);
  const regular = useAuiState((s) => s.threads.threadIds);
  const trash = useAuiState((s) => s.threads.archivedThreadIds);
  if (state.status === "idle") return null;
  if (state.status === "searching") {
    return (
      <p className={chat.hint} role="status">
        Searching…
      </p>
    );
  }
  if (state.status === "error") return <ErrorNotice error={state.error} />;
  if (state.hits.length === 0) {
    return (
      <p className={chat.hint} role="status">
        No threads match “{state.q}”.
      </p>
    );
  }
  const notes = new Map(state.hits.map((h) => [h.threadId, note(h)] as const));
  return (
    <HitNotes.Provider value={notes}>
      <p className="sr-only" role="status">
        {state.hits.length === 1 ? "1 thread matches" : `${state.hits.length} threads match`}
      </p>
      <ul className={chat.threadList} aria-label="Search results">
        {state.hits.map((hit) => {
          const item = items.find((i) => i.remoteId === hit.threadId);
          const inList = item ? regular.indexOf(item.id) : -1;
          const inTrash = item ? trash.indexOf(item.id) : -1;
          if (inList >= 0) {
            return (
              <ThreadListPrimitive.ItemByIndex
                key={hit.threadId}
                index={inList}
                components={THREAD_ITEM}
              />
            );
          }
          if (inTrash >= 0) {
            return (
              <ThreadListPrimitive.ItemByIndex
                key={hit.threadId}
                index={inTrash}
                archived
                components={TRASH_ITEM}
              />
            );
          }
          return (
            <li key={hit.threadId} data-kobe-thread={hit.threadId}>
              <span className={chat.threadItem}>
                <button type="button" className={chat.threadTrigger}>
                  {hit.title ?? "Untitled conversation"}
                </button>
              </span>
              {notes.get(hit.threadId)}
            </li>
          );
        })}
      </ul>
      {state.next !== null && (
        <button type="button" className={shell.hitTitle} onClick={more}>
          More results
        </button>
      )}
    </HitNotes.Provider>
  );
}
