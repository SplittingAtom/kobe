"use client";

import { useAui, useAuiState } from "@assistant-ui/react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { ThreadController } from "../../lib/chat/thread-controller";
import { renameBlocker } from "../../lib/chat/thread-commands";
import type { ThreadState } from "../../lib/chat/thread-state";
import { useBindCommands } from "../shell/command-bindings";
import { useDraftProjectName, useDraftProjectState } from "./use-draft-project";

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
 * The conversation header's name (KOBE-292): a click on the name itself opens the field (Chris
 * 2026-11-06; the pencil is gone). Enter, or
 * leaving the field, saves a changed name through the thread list's rename (the existing `PATCH
 * /v1/threads/{id}`, which locks the title against auto-titling), so the rail shows it at once;
 * an empty name clears it (unlocked again, "Untitled conversation"). Escape cancels. A refused
 * save keeps the field open with the server's reason. Focus returns to the name after Enter or
 * Escape. The heading stays the conversation region's label (visually hidden while the name is
 * the button, or the field is open); the button is named "Rename <title>".
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
  const draft_ = state.threadId === null;
  // NC1: a conversation not created yet says which project it will be in.
  const { projectId } = useDraftProjectState();
  const projectName = useDraftProjectName(draft_ ? projectId : null);
  const inProject = draft_ && projectId !== null;
  const title = !draft_
    ? (named ?? UNTITLED)
    : inProject
      ? `New conversation in ${projectName ?? "…"}`
      : "New conversation";

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
  const close = (focusName: boolean) => {
    phase.current = "closed";
    returnFocus.current = focusName;
    setError(null);
    setDraft(null);
  };

  /** Saves a changed name (empty clears it); closes on success, stays open with the reason. */
  const commit = async (focusName: boolean) => {
    if (phase.current !== "editing") return;
    const next = (draft ?? "").trim().slice(0, MAX_TITLE);
    if (next === (named ?? "")) return close(focusName);
    phase.current = "saving";
    try {
      await aui.threadListItem.rename(next);
    } catch (err) {
      phase.current = "editing";
      setError(messageOf(err));
      return;
    }
    close(focusName);
    void controller?.refresh();
  };

  // `/rename` (KOBE-224) opens the same field as a click on the name, or says why it can't.
  useBindCommands(
    editable ? { "rename-thread": { onSelect: open, blocker: renameBlocker(state) } } : {},
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void commit(true);
  };

  const renameable = editable && canRename(state);
  return (
    <span ref={wrapper} className="flex min-w-0 flex-wrap items-center gap-1">
      <h2
        id="kobe-thread-title"
        className={draft === null && !renameable ? "text-sm font-medium" : "sr-only"}
      >
        {inProject ? (
          <>
            New conversation in{" "}
            <span
              className="inline-block max-w-[16ch] truncate align-bottom"
              title={projectName ?? undefined}
            >
              {projectName ?? "…"}
            </span>
          </>
        ) : (
          title
        )}
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
        renameable && (
          <button
            type="button"
            data-command="rename-thread"
            aria-label={`Rename ${title}`}
            title="Click to rename"
            onClick={open}
            className="hover:bg-muted focus-visible:ring-ring -mx-1 min-w-0 cursor-text rounded-md px-1 text-start text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
          >
            {title}
          </button>
        )
      )}
    </span>
  );
}
