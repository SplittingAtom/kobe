"use client";

import { useAui, useAuiState } from "@assistant-ui/react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ThreadState } from "../../lib/chat/thread-state";
import { IconAction } from "../shell/icon-action";

const UNTITLED = "Untitled conversation";
const MAX_TITLE = 200;

/** The owner's saved thread out of Trash can be renamed; a shared, read-only one cannot. */
function canRename(state: ThreadState): boolean {
  const summary = state.summary;
  return (
    state.threadId !== null &&
    summary !== undefined &&
    summary.readOnly !== true &&
    summary.deletedAt == null
  );
}

/**
 * The conversation header's name (KOBE-292) with a pencil to rename it in place: Enter saves
 * through the thread list's rename (the existing `PATCH /v1/threads/{id}`, which also locks the
 * title against auto-titling, KOBE-219), so the rail shows the new name at once; Escape (or
 * leaving the field) cancels. Focus returns to the pencil. The heading stays the conversation
 * region's label while the field is open.
 */
export function ThreadTitle({
  state,
  editable,
}: {
  readonly state: ThreadState;
  /** The chat shell; the builder's test pane shows the name only. */
  readonly editable: boolean;
}) {
  const aui = useAui();
  const listed = useAuiState((s) => s.threadListItem.title);
  const [draft, setDraft] = useState<string | null>(null);
  const wrapper = useRef<HTMLSpanElement>(null);
  const returnFocus = useRef(false);
  // The list's title first: a rename updates it at once, the summary on the next read.
  const title =
    state.threadId === null ? "New conversation" : listed || state.summary?.title || UNTITLED;

  useEffect(() => {
    if (draft !== null || !returnFocus.current) return;
    returnFocus.current = false;
    wrapper.current?.querySelector<HTMLElement>('[data-command="rename-thread"]')?.focus();
  }, [draft]);

  const close = () => {
    returnFocus.current = true;
    setDraft(null);
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    const next = (draft ?? "").trim().slice(0, MAX_TITLE);
    close();
    if (next !== "" && next !== title) void aui.threadListItem.rename(next);
  };

  return (
    <span ref={wrapper} className="flex min-w-0 items-center gap-1">
      <h2 id="kobe-thread-title" className={draft === null ? "text-sm font-medium" : "sr-only"}>
        {title}
      </h2>
      {draft !== null ? (
        <form onSubmit={save} className="min-w-0">
          <input
            aria-label="Conversation name"
            className="bg-background min-w-0 rounded-md border px-2 py-0.5 text-sm font-medium"
            value={draft}
            maxLength={MAX_TITLE}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => setDraft(null)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              // Handled here: the rail's drawer or a sheet must not close on the same key.
              e.preventDefault();
              e.stopPropagation();
              close();
            }}
          />
        </form>
      ) : (
        editable &&
        canRename(state) && (
          <IconAction
            command="rename-thread"
            label={`Rename ${title}`}
            size="sm"
            onClick={() => setDraft(title)}
          />
        )
      )}
    </span>
  );
}
