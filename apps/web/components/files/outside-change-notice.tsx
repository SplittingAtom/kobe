"use client";

/**
 * The file editor's answers to an outside change (KOBE-491): the banner while the member has
 * unsaved edits, the same choices after a save found the file changed (409), and Compare: the
 * agent's version against the member's draft in the proposal review's inline diff (Accept keeps
 * the member's text at a change, Reject takes the agent's there; the result stays the draft).
 * KOBE-496: the badge at the top of the editor when someone else changed the file of a clean tab
 * ("<who> changed this file <when>" with Reload), and the banner names who when the stream said.
 */
import { Suspense, useEffect, useRef, useState } from "react";
import type { ApiError } from "../../lib/api/client";
import type { FilesApi } from "../../lib/files/api";
import { editorLanguage, sha256Hex } from "../../lib/files/editor";
import { describeFileError } from "../../lib/files/format";
import { decodePreviewText, previewOf, TEXT_PREVIEW_MAX_BYTES } from "../../lib/files/preview";
import { ErrorNotice } from "../admin/error-notice";
import { BUTTON, CodeEditor, EditorFallback } from "./text-modes";
import type { ChangedBy } from "./use-outside-change";

export const UPDATED_NOTE = "Updated by the agent just now.";
export const AGENT_CHANGED_BANNER = "The agent changed this file while you were editing.";
export const SAVE_CONFLICT_NOTICE =
  "This file changed since you opened it (the agent, or another save), so nothing was saved.";
export const TAKE_THEIRS_PROMPT = (name: string) =>
  `Discard your unsaved changes to ${name} and take the agent's version?`;

/** One sentence about who changed the file, ending with `tail` ("just now", "while …"). */
function changeSentence(by: ChangedBy | undefined, tail: string): string {
  const actor = by?.actor;
  switch (actor?.kind) {
    case "agent":
      return `The agent changed this file ${tail}.`;
    case "user":
      return `You changed this file in another tab or device ${tail}.`;
    case "sync":
      return actor.name === null
        ? `This project file was updated ${tail}.`
        : `${actor.name} updated this project file ${tail}.`;
    default:
      return `This file changed outside this tab ${tail}.`;
  }
}

/** "just now", "5 min ago", or the time of day (older than an hour), from `at`. */
export function changedWhen(at: string | null | undefined, now: number = Date.now()): string {
  if (!at) return "just now";
  const ms = now - Date.parse(at);
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  return `at ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/** The badge's text: who changed the file and when ("This file changed …" when not known). */
export function changedBadgeText(by: ChangedBy | undefined, now?: number): string {
  return changeSentence(by, changedWhen(by?.at, now));
}

/**
 * Someone else changed the file of a clean tab (KOBE-496): nothing was replaced; Reload reads it
 * in place. A polite live region at the top of the editor, the same for read-only viewers.
 */
export function ChangedBadge({
  by,
  name,
  onReload,
}: {
  readonly by: ChangedBy | undefined;
  readonly name: string;
  onReload(): void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-kobe-changed-badge=""
      className="bg-muted/50 flex flex-wrap items-center gap-2 rounded-md border px-2 py-1 text-sm"
    >
      <p className="min-w-0 flex-1">{changedBadgeText(by)}</p>
      <button type="button" className={BUTTON} aria-label={`Reload ${name}`} onClick={onReload}>
        Reload
      </button>
    </div>
  );
}

/** The agent's version as read for Compare. */
export interface Theirs {
  readonly text: string;
  readonly sha256: string;
}

export function OutsideChoices({
  mode,
  by,
  busy,
  comparing,
  onCompare,
  onKeepMine,
  onTakeTheirs,
}: {
  /** `banner`: found while editing; `conflict`: a save was refused. */
  readonly mode: "banner" | "conflict";
  /** Who changed it, when the change stream said (KOBE-496); the agent otherwise. */
  readonly by?: ChangedBy | undefined;
  readonly busy: boolean;
  readonly comparing: boolean;
  onCompare(): void;
  onKeepMine(): void;
  onTakeTheirs(): void;
}) {
  return (
    <div role="alert" className="rounded-md border p-2 text-sm">
      <p>
        {mode === "banner"
          ? `${bannerText(by)} Nothing was replaced.`
          : `${SAVE_CONFLICT_NOTICE} Keep mine saves your version over it.`}
      </p>
      <div className="mt-1 flex flex-wrap gap-1">
        <button
          type="button"
          className={BUTTON}
          aria-pressed={comparing}
          disabled={busy}
          onClick={onCompare}
        >
          Compare
        </button>
        <button type="button" className={BUTTON} disabled={busy} onClick={onKeepMine}>
          Keep mine
        </button>
        <button type="button" className={BUTTON} disabled={busy} onClick={onTakeTheirs}>
          Take theirs
        </button>
      </div>
    </div>
  );
}

function bannerText(by: ChangedBy | undefined): string {
  const kind = by?.actor?.kind;
  if (kind === undefined || kind === "agent") return AGENT_CHANGED_BANNER;
  return changeSentence(by, "while you were editing here");
}

/** Reads the file's current synced content for Compare (the whole text, or an error). */
async function readTheirs(api: FilesApi, path: string): Promise<Theirs | ApiError> {
  const read = await api.read(path, TEXT_PREVIEW_MAX_BYTES);
  if (!read.ok) return describeFileError(read.error);
  const text = read.data.truncated ? null : decodePreviewText(read.data.bytes, false);
  if (text === null) {
    return { status: 413, code: "too_large", message: "This file is too large to compare here." };
  }
  return { text, sha256: await sha256Hex(read.data.bytes) };
}

/** The member's draft (editable) against the agent's version. */
export function CompareView({
  api,
  path,
  name,
  draft,
  onDraft,
  onTheirs,
}: {
  readonly api: FilesApi;
  readonly path: string;
  readonly name: string;
  readonly draft: string;
  onDraft(text: string): void;
  /** The version compared against: Keep mine saves over exactly this one. */
  onTheirs(theirs: Theirs): void;
}) {
  const [state, setState] = useState<Theirs | ApiError | null>(null);
  // Read once per Compare, not again when the caller re-renders.
  const report = useRef(onTheirs);
  report.current = onTheirs;
  useEffect(() => {
    let current = true;
    void readTheirs(api, path).then((res) => {
      if (!current) return;
      setState(res);
      if ("sha256" in res) report.current(res);
    });
    return () => {
      current = false;
    };
  }, [api, path]);
  if (state === null) {
    return (
      <p role="status" aria-live="polite" aria-label={`Loading the agent's version of ${name}`}>
        Loading the agent&apos;s version…
      </p>
    );
  }
  if (!("sha256" in state)) return <ErrorNotice error={state} />;
  return (
    <section aria-label={`Compare ${name}`} className="flex min-h-0 flex-1 flex-col gap-2">
      <p className="text-muted-foreground text-xs">
        Your version against the agent&apos;s: Accept keeps your text at a change, Reject takes the
        agent&apos;s. The result stays unsaved until you save.
      </p>
      <Suspense fallback={<EditorFallback />}>
        <CodeEditor
          value={draft}
          original={state.text}
          language={editorLanguage(previewOf(path))}
          label={`Your ${name} against the agent's version`}
          onChange={onDraft}
        />
      </Suspense>
    </section>
  );
}
