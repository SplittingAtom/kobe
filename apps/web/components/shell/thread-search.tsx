"use client";

import { useAuiState } from "@assistant-ui/react";
import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import type { ApiError } from "../../lib/api/client";
import type { ThreadSearchHit } from "../../lib/chat/types";
import { ErrorNotice } from "../admin/error-notice";
import { useChatSession } from "../chat/kobe-runtime";
import chatStyles from "../chat/chat.module.css";
import styles from "./shell.module.css";

function SearchResults({
  hits,
  onOpen,
}: {
  readonly hits: readonly ThreadSearchHit[];
  readonly onOpen: (threadId: string) => void;
}) {
  if (hits.length === 0) return <p className={chatStyles.hint}>No conversations match.</p>;
  return (
    <ul className={styles.hits} aria-label="Search results">
      {hits.map((hit) => (
        <li key={hit.threadId}>
          <button type="button" className={styles.hitTitle} onClick={() => onOpen(hit.threadId)}>
            {hit.title ?? "Untitled conversation"}
          </button>
          {/* Archived threads stay searchable (CE19), marked so the member knows where they live. */}
          {hit.archivedAt != null && (
            <span className={styles.hitBadge} data-kobe-archived="">
              Archived
            </span>
          )}
          {hit.snippet && (
            <p className={styles.snippet}>
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
  | { readonly status: "searching"; readonly q: string; readonly seq: number }
  | { readonly status: "done"; readonly q: string; readonly hits: readonly ThreadSearchHit[] }
  | { readonly status: "error"; readonly q: string; readonly error: ApiError };

/**
 * Global thread search in bar row one (CE3; KOBE-33 `?q=`). Results open beside the thread, as a
 * panel under the field (CE4). Escape, Clear, a click or focus outside, and opening a thread close
 * it; only the newest search's reply is ever shown.
 */
export function ThreadSearch({ onOpenThread }: { readonly onOpenThread: (id: string) => void }) {
  const session = useChatSession();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchState>({ status: "idle" });
  const box = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const close = () => setSearch({ status: "idle" });

  // Another thread on screen (from the rail, a hit, the bell): the results have done their job.
  const threadId = useAuiState((s) => s.threadListItem.id);
  const [seenThread, setSeenThread] = useState(threadId);
  if (seenThread !== threadId) {
    setSeenThread(threadId);
    close();
  }

  const open = search.status !== "idle";
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setSearch({ status: "idle" });
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const runSearch = async (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (q === "") {
      close();
      return;
    }
    const mine = ++seq.current;
    setSearch({ status: "searching", q, seq: mine });
    const res = await session.api.searchThreads(q);
    // Only into the search still waiting for it: closed meanwhile, or a newer one, drops it.
    setSearch((cur) =>
      cur.status !== "searching" || cur.seq !== mine
        ? cur
        : res.ok
          ? { status: "done", q, hits: res.data.threads }
          : { status: "error", q, error: res.error },
    );
  };

  const clear = () => {
    setQuery("");
    close();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      close();
    }
  };
  const onBlur = (e: FocusEvent) => {
    if (open && !box.current?.contains(e.relatedTarget as Node | null)) close();
  };

  return (
    <div ref={box} className={styles.searchBox} onKeyDown={onKeyDown} onBlur={onBlur}>
      <form role="search" onSubmit={(e) => void runSearch(e)}>
        <label className="sr-only" htmlFor="kobe-search">
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
        <button type="submit" className="sr-only">
          Search
        </button>
      </form>
      {open && (
        <section
          className={styles.results}
          aria-label={`Results for ${search.q}`}
          // Clicking a result keeps focus in the field, so the blur below never closes first.
          onMouseDown={(e) => e.preventDefault()}
        >
          <p className={chatStyles.hint} role="status">
            {search.status === "searching" ? "Searching…" : `Results for “${search.q}”`}{" "}
            <button type="button" onClick={clear}>
              Clear
            </button>
          </p>
          {search.status === "error" && <ErrorNotice error={search.error} />}
          {search.status === "done" && (
            <SearchResults
              hits={search.hits}
              onOpen={(id) => {
                clear();
                onOpenThread(id);
              }}
            />
          )}
        </section>
      )}
    </div>
  );
}
