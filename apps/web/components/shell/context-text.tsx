"use client";

import type { ContextSection } from "@kobe/protocol";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { formatTokens } from "../../lib/admin/usage-format";
import {
  SECTION_LABELS,
  buildRows,
  findMatches,
  splitMatches,
  visibleRange,
} from "../../lib/chat/context-viewer";
import styles from "./context-viewer.module.css";

/** One row's height in px: `.row` in context-viewer.module.css sets the same. */
const ROW_PX = 20;
/** The viewport assumed before it is measured (and where nothing is laid out). */
const FALLBACK_VIEWPORT = 800;

export interface ContextTextHandle {
  /** Scrolls to a section's label and marks it. */
  readonly show: (section: number) => void;
}

function labelOf(s: ContextSection): string {
  const parts = [SECTION_LABELS[s.kind]];
  if (s.label !== "") parts.push(s.label);
  parts.push(`${formatTokens(s.tokens)} tokens`);
  if (s.truncated) parts.push("shortened");
  return parts.join(" · ");
}

/** The line with each match of `query` marked; plain text only. */
function highlighted(text: string, query: string): ReactNode {
  return splitMatches(text, query).map((part, i) =>
    part.hit ? <mark key={i}>{part.text}</mark> : part.text,
  );
}

/**
 * The context's raw text (KOBE-471): each section under a label naming its kind and tokens, its
 * text as sent, monospace, as plain text (it is untrusted: never Markdown or HTML). Rows have one
 * height and only those near the viewport are rendered, so a context of thousands of sections
 * scrolls lightly. The search box marks matches and steps through them (Enter, Shift+Enter).
 */
export function ContextText({
  sections,
  handle,
}: {
  readonly sections: readonly ContextSection[];
  readonly handle: Ref<ContextTextHandle>;
}) {
  const { rows, firstRow } = useMemo(() => buildRows(sections), [sections]);
  const pane = useRef<HTMLDivElement>(null);
  const viewportRef = useRef(FALLBACK_VIEWPORT);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(FALLBACK_VIEWPORT);
  const [active, setActive] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  // Each step bumps it, so stepping to the same match (the only one) scrolls to it again.
  const [stepSeq, setStepSeq] = useState(0);
  const matches = useMemo(() => findMatches(rows, query), [rows, query]);
  // New matches (another query, or a Refresh's text) start again at the first.
  const [seenMatches, setSeenMatches] = useState(matches);
  if (seenMatches !== matches) {
    setSeenMatches(matches);
    setCurrent(0);
  }
  const at = matches.length === 0 ? 0 : Math.min(current, matches.length - 1);

  useEffect(() => {
    const el = pane.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const height = el.clientHeight || FALLBACK_VIEWPORT;
      viewportRef.current = height;
      setViewport(height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const scrollToRow = useCallback((row: number, lead: number) => {
    const top = Math.max(0, row * ROW_PX - lead);
    if (pane.current) pane.current.scrollTop = top;
    setScrollTop(top);
  }, []);

  useImperativeHandle(
    handle,
    () => ({
      show: (section) => {
        const row = firstRow[section];
        if (row === undefined) return;
        setActive(section);
        scrollToRow(row, 0);
      },
    }),
    [firstRow, scrollToRow],
  );

  // The current match is brought into view, a third down from the top.
  const currentRow = matches[at];
  useEffect(() => {
    if (currentRow !== undefined) scrollToRow(currentRow, viewportRef.current / 3);
  }, [currentRow, stepSeq, scrollToRow]);

  const step = (by: number) => {
    if (matches.length === 0) return;
    setCurrent((at + by + matches.length) % matches.length);
    setStepSeq((n) => n + 1);
  };
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    step(e.shiftKey ? -1 : 1);
  };

  const [start, end] = visibleRange({ scrollTop, viewport, rowPx: ROW_PX, count: rows.length });
  const q = query.trim();
  return (
    <div className={styles.textColumn}>
      <div className={styles.search} role="search">
        <input
          type="search"
          aria-label="Search the context"
          placeholder="Search the context"
          className={styles.searchInput}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCurrent(0);
          }}
          onKeyDown={onSearchKey}
        />
        {q !== "" && (
          <>
            <span className={styles.matches} role="status">
              {matches.length === 0 ? "No matches" : `${at + 1} of ${matches.length}`}
            </span>
            <button
              type="button"
              className={styles.smallButton}
              disabled={matches.length === 0}
              onClick={() => step(-1)}
            >
              Previous
            </button>
            <button
              type="button"
              className={styles.smallButton}
              disabled={matches.length === 0}
              onClick={() => step(1)}
            >
              Next
            </button>
          </>
        )}
      </div>
      <div
        ref={pane}
        role="region"
        aria-label="Context text"
        tabIndex={0}
        className={styles.pane}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div className={styles.spacer} style={{ height: rows.length * ROW_PX }}>
          {rows.slice(start, end).map((row, k) => {
            const i = start + k;
            const s = sections[row.section];
            if (s === undefined) return null;
            if (row.type === "label") {
              return (
                <div
                  key={i}
                  className={`${styles.row} ${styles.label}`}
                  data-kind={s.kind}
                  data-active={active === row.section || undefined}
                  style={{ top: i * ROW_PX }}
                >
                  {labelOf(s)}
                </div>
              );
            }
            return (
              <div
                key={i}
                className={`${styles.row} ${styles.line}`}
                data-current={i === currentRow || undefined}
                style={{ top: i * ROW_PX }}
              >
                {highlighted(row.text, query)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
