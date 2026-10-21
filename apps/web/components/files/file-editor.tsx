"use client";

/**
 * A workspace text file in the artifact column (KOBE-463, spec docs/specs/file-editor.md):
 * Rendered (today's renderers) and Raw (CodeMirror, loaded lazily) modes. Raw edits are kept as
 * a draft per file (the session's `editDrafts`) until saved; Save sends the version the draft was
 * based on, and a 409 says the file changed meanwhile (nothing is overwritten). Project files,
 * thread uploads and files over the preview cap open read-only with a notice. An agent proposal
 * under review (the session's `fileReviews`) replaces both modes with the inline diff: per-change
 * Accept/Reject, Commit all (saves at the proposal's base version, FE10) and Discard all.
 */
import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from "react";
import type { ApiError } from "../../lib/api/client";
import type { FilesApi } from "../../lib/files/api";
import { editBlockReason, editorLanguage, sha256Hex } from "../../lib/files/editor";
import type { EditDraftStore, FileReviewStore, ProposalView } from "../../lib/files/editor-state";
import { describeFileError } from "../../lib/files/format";
import { fileName, previewOf } from "../../lib/files/preview";
import { ErrorNotice } from "../admin/error-notice";
import { TextView } from "./text-view";

const CodeEditor = lazy(() => import("./code-editor"));

export const CONFLICT_NOTICE =
  "This file changed since it was opened here (another save, or the agent), so nothing was saved.";
const DISCARD_PROMPT = (name: string) => `Discard your unsaved changes to ${name}?`;

type Mode = "rendered" | "raw";

const BUTTON = "hover:bg-muted rounded-md border px-2 py-0.5 text-xs disabled:opacity-50";

/** The editor's saved version: the server's, else computed from what was saved. */
async function savedVersion(text: string, sha256: string | undefined): Promise<string> {
  return sha256 ?? sha256Hex(new TextEncoder().encode(text));
}

function useDraft(drafts: EditDraftStore, path: string) {
  return useSyncExternalStore(
    drafts.subscribe,
    () => drafts.get(path),
    () => undefined,
  );
}

function useReview(reviews: FileReviewStore, path: string) {
  return useSyncExternalStore(
    reviews.subscribe,
    () => reviews.reviewOf(path),
    () => undefined,
  );
}

/** Asks before the page unloads while any file has unsaved changes. */
export function useUnsavedGuard(drafts: EditDraftStore): void {
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!drafts.hasAny()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [drafts]);
}

/** Whether the file's tab may close: no unsaved draft, or the member agreed to drop it. */
export function confirmDiscard(drafts: EditDraftStore, path: string): boolean {
  if (drafts.get(path) === undefined) return true;
  if (!window.confirm(DISCARD_PROMPT(fileName(path)))) return false;
  drafts.clear(path);
  return true;
}

export interface FileEditorProps {
  readonly path: string;
  /** The file as read. */
  readonly text: string;
  /** The version read; undefined when the read was cut (then it cannot be saved whole). */
  readonly sha256: string | undefined;
  readonly truncated: boolean;
  readonly api: FilesApi;
  readonly drafts: EditDraftStore;
  readonly reviews: FileReviewStore;
  /** A save went through: the tab shows `text` at version `sha256`. */
  onSaved(text: string, sha256: string): void;
  /** Read the file again (after a conflict). */
  onReload(): void;
}

type SaveState =
  | { readonly status: "idle" | "saving" | "saved" | "conflict" }
  | { readonly status: "error"; readonly error: ApiError };

/** One save at a version; reports conflicts and errors, and the new version on success. */
function useSave(api: FilesApi, path: string, onSaved: (text: string, sha256: string) => void) {
  const [state, setState] = useState<SaveState>({ status: "idle" });
  const save = async (base: string, text: string): Promise<boolean> => {
    setState({ status: "saving" });
    const res = await api.save(path, base, text);
    if (res.ok) {
      onSaved(text, await savedVersion(text, res.data.sha256));
      setState({ status: "saved" });
      return true;
    }
    setState(
      res.error.code === "version_conflict"
        ? { status: "conflict" }
        : { status: "error", error: describeFileError(res.error) },
    );
    return false;
  };
  return { state, save, reset: () => setState({ status: "idle" }) };
}

function SaveNotices({ state, onReload }: { readonly state: SaveState; onReload(): void }) {
  if (state.status === "error") return <ErrorNotice error={state.error} />;
  if (state.status !== "conflict") return null;
  return (
    <div role="alert" className="mb-2 rounded-md border p-2 text-sm">
      <p>{`${CONFLICT_NOTICE} Copy your changes if you need them, then reload the file.`}</p>
      <button type="button" className={`${BUTTON} mt-1`} onClick={onReload}>
        Reload the file
      </button>
    </div>
  );
}

function EditorFallback() {
  return <p role="status">Loading the editor…</p>;
}

export function FileEditor(props: FileEditorProps) {
  const { path, text, sha256, truncated, drafts, reviews } = props;
  const draft = useDraft(drafts, path);
  const review = useReview(reviews, path);
  const [mode, setMode] = useState<Mode>(draft === undefined ? "rendered" : "raw");
  const { state, save, reset } = useSave(props.api, path, (saved, version) => {
    // Keystrokes typed while the save was in flight stay unsaved, now based on the new version.
    const latest = drafts.get(path);
    if (latest === undefined || latest.text === saved) drafts.clear(path);
    else drafts.set(path, { text: latest.text, baseSha256: version });
    props.onSaved(saved, version);
  });
  const blocked =
    editBlockReason(path, truncated) ??
    (sha256 === undefined ? "This file's version is unknown, so it opens read-only." : undefined);
  const current = draft?.text ?? text;
  const base = draft?.baseSha256 ?? sha256;
  const name = fileName(path);
  const reload = () => {
    if (draft !== undefined && !window.confirm(DISCARD_PROMPT(name))) return;
    drafts.clear(path);
    reset();
    props.onReload();
  };
  const edit = (next: string) => {
    if (base === undefined) return;
    if (next === text && base === sha256) drafts.clear(path);
    else drafts.set(path, { text: next, baseSha256: base });
    if (state.status === "saved") reset();
  };

  if (review !== undefined) {
    return (
      <ProposalReview
        key={review.toolCallId}
        {...props}
        review={review}
        dirty={draft !== undefined}
      />
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div role="toolbar" aria-label={`${name} view`} className="flex items-center gap-1">
        {(["rendered", "raw"] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            className={`${BUTTON} aria-pressed:bg-muted`}
            onClick={() => setMode(m)}
          >
            {m === "rendered" ? "Rendered" : "Raw"}
          </button>
        ))}
        {blocked === undefined && (
          <button
            type="button"
            className={`${BUTTON} ms-auto`}
            disabled={draft === undefined || state.status === "saving" || base === undefined}
            onClick={() => base !== undefined && void save(base, current)}
          >
            {state.status === "saving" ? "Saving…" : "Save"}
          </button>
        )}
      </div>
      <p role="status" className="text-muted-foreground text-xs empty:hidden">
        {draft !== undefined ? "Unsaved changes." : state.status === "saved" ? "Saved." : ""}
      </p>
      {blocked !== undefined && (
        <p role="note" className="text-muted-foreground text-xs">
          {blocked}
        </p>
      )}
      <SaveNotices state={state} onReload={reload} />
      {mode === "rendered" ? (
        <TextView text={current} preview={previewOf(path)} />
      ) : (
        <Suspense fallback={<EditorFallback />}>
          <CodeEditor
            value={current}
            language={editorLanguage(previewOf(path))}
            label={`Edit ${name}`}
            readOnly={blocked !== undefined}
            onChange={edit}
          />
        </Suspense>
      )}
    </div>
  );
}

function ProposalReview({
  path,
  text,
  sha256,
  api,
  drafts,
  reviews,
  onSaved,
  onReload,
  review,
  dirty,
}: FileEditorProps & { readonly review: ProposalView; readonly dirty: boolean }) {
  const [proposed, setProposed] = useState(review.content);
  // The file as the review started: a re-read never rebuilds the diff (and its accept/reject);
  // a file that moved on ends the review with the notice below instead.
  const [original] = useState(text);
  const [open, setOpen] = useState<number | null>(null);
  const { state, save } = useSave(api, path, (saved, version) => {
    reviews.finish(path, "committed");
    onSaved(saved, version);
  });
  const discard = () => reviews.finish(path, "discarded");
  const name = fileName(path);
  const stale = sha256 !== review.baseSha256;
  return (
    <section aria-label={`Proposed edit to ${name}`} className="flex min-h-0 flex-1 flex-col gap-2">
      <p className="text-sm">
        <strong>Proposed edit:</strong> {review.summary}
      </p>
      {stale ? (
        <div role="alert" className="rounded-md border p-2 text-sm">
          <p>
            {name} changed since the agent proposed this edit, so it can no longer be applied.
            Discard it and ask the agent to propose again.
          </p>
          <button type="button" className={`${BUTTON} mt-1`} onClick={discard}>
            Discard the proposal
          </button>
        </div>
      ) : dirty ? (
        <div role="alert" className="rounded-md border p-2 text-sm">
          <p>You have unsaved changes to {name}. Save or discard them to review the proposal.</p>
          <button type="button" className={`${BUTTON} mt-1`} onClick={() => drafts.clear(path)}>
            Discard my changes
          </button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1">
            <p role="status" className="text-muted-foreground me-auto text-xs">
              {open === null
                ? ""
                : `${open === 1 ? "1 change" : `${open} changes`} to accept or reject. Commit all saves what is shown.`}
            </p>
            <button
              type="button"
              className={BUTTON}
              disabled={state.status === "saving" || proposed === original}
              onClick={() => void save(review.baseSha256, proposed)}
            >
              {state.status === "saving" ? "Committing…" : "Commit all"}
            </button>
            <button type="button" className={BUTTON} onClick={discard}>
              Discard all
            </button>
          </div>
          <SaveNotices state={state} onReload={onReload} />
          <Suspense fallback={<EditorFallback />}>
            <CodeEditor
              value={review.content}
              original={original}
              language={editorLanguage(previewOf(path))}
              label={`Proposed content of ${name}`}
              onChange={setProposed}
              onChunks={setOpen}
            />
          </Suspense>
        </>
      )}
    </section>
  );
}
