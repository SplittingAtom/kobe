"use client";

import { useAui, useAuiState } from "@assistant-ui/react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { ThreadController } from "../../lib/chat/thread-controller";
import type { ThreadState } from "../../lib/chat/thread-state";
import { IconAction } from "../shell/icon-action";

const UNTITLED = "Untitled conversation";
const MAX_TITLE = 200;
const NOT_SAVED = "The name could not be saved. Try again.";

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

/** The server's message for a refused rename (the list adapter rejects with its `apiError`). */
function messageOf(err: unknown): string {
  const apiError = (err as { apiError?: { message?: unknown } } | null)?.apiError;
  return typeof apiError?.message === "string" ? apiError.message : NOT_SAVED;
}

/** The field's lifecycle: a blur after Escape, or while saving, must not save again. */
type Phase = "closed" | "editing" | "saving";

/**
 * The conversation header's name (KOBE-292) with a pencil to rename it in place. Enter, or
 * leaving the field, saves a changed name through the thread list's rename (the existing `PATCH
 * /v1/threads/{id}`, which locks the title against auto-titling), so the rail shows it at once;
 * an empty name clears it (unlocked again, "Untitled conversation"). Escape cancels. A refused
 * save keeps the field open with the server's reason. Focus returns to the pencil after Enter or
 * Escape. The heading stays the conversation region's label while the field is open.
 */
export function ThreadTitle({
  state,
  controller,
  editable,
}: {
  readonly state: ThreadState;
  /** Read again after a save, so the summary's title follows (a cleared name too). */
  readonly controller: ThreadController | null;
  /** The chat shell; the builder's test pane shows the name only. */
  readonly editable: boolean;
}) {
  const aui = useAui();
  const listed = useAuiState((s) => s.threadListItem.title);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const phase = useRef<Phase>("closed");
  const wrapper = useRef<HTMLSpanElement>(null);
  const returnFocus = useRef(false);
  const errorId = useId();
  // The list's title first: a rename updates it at once, the summary on the next read.
  const named = listed || state.summary?.title || null;
  const title = state.threadId === null ? "New conversation" : (named ?? UNTITLED);

  useEffect(() => {
    if (draft !== null || !returnFocus.current) return;
    returnFocus.current = false;
    wrapper.current?.querySelector<HTMLElement>('[data-command="rename-thread"]')?.focus();
  }, [draft]);

  const open = () => {
    phase.current = "editing";
    setError(null);
    setDraft(named ?? "");
  };
  const close = (focusPencil: boolean) => {
    phase.current = "closed";
    returnFocus.current = focusPencil;
    setError(null);
    setDraft(null);
  };

  /** Saves a changed name (empty clears it); closes on success, stays open with the reason. */
  const commit = async (focusPencil: boolean) => {
    if (phase.current !== "editing") return;
    const next = (draft ?? "").trim().slice(0, MAX_TITLE);
    if (next === (named ?? "")) return close(focusPencil);
    phase.current = "saving";
    try {
      await aui.threadListItem.rename(next);
    } catch (err) {
      phase.current = "editing";
      setError(messageOf(err));
      return;
    }
    close(focusPencil);
    void controller?.refresh();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void commit(true);
  };

  return (
    <span ref={wrapper} className="flex min-w-0 flex-wrap items-center gap-1">
      <h2 id="kobe-thread-title" className={draft === null ? "text-sm font-medium" : "sr-only"}>
        {title}
      </h2>
      {draft !== null ? (
        <form onSubmit={submit} className="flex min-w-0 flex-wrap items-center gap-2">
          <input
            aria-label="Conversation name"
            aria-invalid={error !== null || undefined}
            aria-describedby={error !== null ? errorId : undefined}
            placeholder={UNTITLED}
            className="bg-background min-w-0 rounded-md border px-2 py-0.5 text-sm font-medium"
            value={draft}
            maxLength={MAX_TITLE}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit(false)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              // Handled here: the rail's drawer or a sheet must not close on the same key.
              e.preventDefault();
              e.stopPropagation();
              close(true);
            }}
          />
          {error !== null && (
            <span id={errorId} role="alert" className="text-destructive text-xs">
              {error}
            </span>
          )}
        </form>
      ) : (
        editable &&
        canRename(state) && (
          <IconAction command="rename-thread" label={`Rename ${title}`} size="sm" onClick={open} />
        )
      )}
    </span>
  );
}
