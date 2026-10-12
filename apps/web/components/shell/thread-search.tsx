"use client";

import { useState, type FormEvent, type KeyboardEvent } from "react";
import type { ApiError } from "../../lib/api/client";
import type { ThreadSearchHit } from "../../lib/chat/types";
import { ErrorNotice } from "../admin/error-notice";
import { useChatSession } from "../chat/kobe-runtime";
import styles from "./shell.module.css";

function SearchResults({
  hits,
  onOpen,
}: {
  readonly hits: readonly ThreadSearchHit[];
  readonly onOpen: (threadId: string) => void;
}) {
  if (hits.length === 0) return <p className={styles.hint}>No conversations match.</p>;
  return (
    <ul className={styles.hits} aria-label="Search results">
      {hits.map((hit) => (
        <li key={hit.threadId}>
          <button type="button" className={styles.hitTitle} onClick={() => onOpen(hit.threadId)}>
            {hit.title ?? "Untitled conversation"}
          </button>
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
  | { readonly status: "searching"; readonly q: string }
  | { readonly status: "done"; readonly q: string; readonly hits: readonly ThreadSearchHit[] }
  | { readonly status: "error"; readonly q: string; readonly error: ApiError };

/**
 * Global thread search in bar row one (CE3; KOBE-33 `?q=`). Results open beside the thread, as a
 * panel under the field (CE4); Escape or Clear closes it.
 */
export function ThreadSearch({ onOpenThread }: { readonly onOpenThread: (id: string) => void }) {
  const session = useChatSession();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchState>({ status: "idle" });

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

  const clear = () => {
    setQuery("");
    setSearch({ status: "idle" });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && search.status !== "idle") {
      e.stopPropagation();
      setSearch({ status: "idle" });
    }
  };

  return (
    <div className={styles.searchBox} onKeyDown={onKeyDown}>
      <form role="search" onSubmit={(e) => void runSearch(e)}>
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
        <button type="submit" className={styles.visuallyHidden}>
          Search
        </button>
      </form>
      {search.status !== "idle" && (
        <section className={styles.results} aria-label={`Results for ${search.q}`}>
          <p className={styles.hint} role="status">
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
