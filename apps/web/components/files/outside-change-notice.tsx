"use client";

/**
 * The file editor's answers to an outside change (KOBE-491): the banner while the member has
 * unsaved edits, the same choices after a save found the file changed (409), and Compare: the
 * agent's version against the member's draft in the proposal review's inline diff (Accept keeps
 * the member's text at a change, Reject takes the agent's there; the result stays the draft).
 */
import { Suspense, useEffect, useRef, useState } from "react";
import type { ApiError } from "../../lib/api/client";
import type { FilesApi } from "../../lib/files/api";
import { editorLanguage, sha256Hex } from "../../lib/files/editor";
import { describeFileError } from "../../lib/files/format";
import { decodePreviewText, previewOf, TEXT_PREVIEW_MAX_BYTES } from "../../lib/files/preview";
import { ErrorNotice } from "../admin/error-notice";
import { BUTTON, CodeEditor, EditorFallback } from "./text-modes";

export const UPDATED_NOTE = "Updated by the agent just now.";
export const AGENT_CHANGED_BANNER = "The agent changed this file while you were editing.";
export const SAVE_CONFLICT_NOTICE =
  "This file changed since you opened it (the agent, or another save), so nothing was saved.";
export const TAKE_THEIRS_PROMPT = (name: string) =>
  `Discard your unsaved changes to ${name} and take the agent's version?`;

/** The agent's version as read for Compare. */
export interface Theirs {
  readonly text: string;
  readonly sha256: string;
}

export function OutsideChoices({
  mode,
  busy,
  comparing,
  onCompare,
  onKeepMine,
  onTakeTheirs,
}: {
  /** `banner`: found while editing; `conflict`: a save was refused. */
  readonly mode: "banner" | "conflict";
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
          ? `${AGENT_CHANGED_BANNER} Nothing was replaced.`
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
  if (state === null) return <p role="status">Loading the agent&apos;s version…</p>;
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
