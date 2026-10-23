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
import { Suspense, useEffect, useState, useSyncExternalStore } from "react";
import type { OutsideChange } from "./use-outside-change";
import type { ApiError } from "../../lib/api/client";
import type { FilesApi } from "../../lib/files/api";
import { editBlockReason, editorLanguage, sha256Hex } from "../../lib/files/editor";
import type { EditDraftStore, FileReviewStore, ProposalView } from "../../lib/files/editor-state";
import { describeFileError } from "../../lib/files/format";
import { fileVersion } from "../../lib/files/outside-change";
import { fileName, previewOf } from "../../lib/files/preview";
import { ErrorNotice } from "../admin/error-notice";
import {
  CompareView,
  OutsideChoices,
  TAKE_THEIRS_PROMPT,
  UPDATED_NOTE,
} from "./outside-change-notice";
import {
  BUTTON,
  CodeEditor,
  EditorFallback,
  TextModeBody,
  TextModeToolbar,
  type TextMode,
} from "./text-modes";

export { BUTTON, EditorFallback };

export const CONFLICT_NOTICE =
  "This file changed since it was opened here (another save, or the agent), so nothing was saved.";
const CHANGED_AGAIN: ApiError = {
  status: 409,
  code: "version_conflict",
  message:
    "The file changed again, so nothing was saved. Compare again, or Keep mine to save over the newest version.",
};
const DISCARD_PROMPT = (name: string) => `Discard your unsaved changes to ${name}?`;

/** The editor's saved version: the server's, else computed from what was saved. */
async function savedVersion(text: string, sha256: string | undefined): Promise<string> {
  return sha256 ?? sha256Hex(new TextEncoder().encode(text));
}

export function useDraft(drafts: EditDraftStore, path: string) {
  return useSyncExternalStore(
    drafts.subscribe,
    () => drafts.get(path),
    () => undefined,
  );
}

export function useReview(reviews: FileReviewStore, path: string) {
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
  /** The file changed outside this tab (KOBE-491): read in, or waiting behind a draft. */
  readonly outside?: OutsideChange | null | undefined;
  /** Keep mine on the banner (or a save over the agent's version): stop showing it. */
  onOutsideDismiss?(): void;
}

export type SaveState =
  | { readonly status: "idle" | "saving" | "saved" | "conflict" }
  | { readonly status: "error"; readonly error: ApiError };

/** One save at a version; reports conflicts and errors, and the new version on success. */
export function useSave(
  api: FilesApi,
  path: string,
  onSaved: (text: string, sha256: string) => void,
) {
  const [state, setState] = useState<SaveState>({ status: "idle" });
  const save = async (base: string, text: string): Promise<"saved" | "conflict" | "error"> => {
    setState({ status: "saving" });
    const res = await api.save(path, base, text);
    if (res.ok) {
      onSaved(text, await savedVersion(text, res.data.sha256));
      setState({ status: "saved" });
      return "saved";
    }
    const conflict = res.error.code === "version_conflict";
    setState(
      conflict ? { status: "conflict" } : { status: "error", error: describeFileError(res.error) },
    );
    return conflict ? "conflict" : "error";
  };
  return { state, save, reset: () => setState({ status: "idle" }) };
}

export function SaveNotices({ state, onReload }: { readonly state: SaveState; onReload(): void }) {
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

export function FileEditor(props: FileEditorProps) {
  const { path, text, sha256, truncated, drafts, reviews } = props;
  const draft = useDraft(drafts, path);
  const review = useReview(reviews, path);
  const [mode, setMode] = useState<TextMode>(draft === undefined ? "rendered" : "raw");
  const { state, save, reset } = useSave(props.api, path, (saved, version) => {
    // Keystrokes typed while the save was in flight stay unsaved, now based on the new version.
    const latest = drafts.get(path);
    if (latest === undefined || latest.text === saved) drafts.clear(path);
    else drafts.set(path, { text: latest.text, baseSha256: version });
    props.onSaved(saved, version);
  });
  const outside = useOutsideChoices(props, draft, state, { save, reset });
  const blocked =
    editBlockReason(path, truncated) ??
    (sha256 === undefined ? "This file's version is unknown, so it opens read-only." : undefined);
  const current = draft?.text ?? text;
  const base = draft?.baseSha256 ?? sha256;
  const name = fileName(path);
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
  const updated =
    props.outside?.kind === "updated" && props.outside.sha256 === sha256 && draft === undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <TextModeToolbar label={`${name} view`} mode={mode} onMode={setMode}>
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
      </TextModeToolbar>
      <p role="status" className="text-muted-foreground text-xs empty:hidden">
        {draft !== undefined
          ? "Unsaved changes."
          : state.status === "saved"
            ? "Saved."
            : updated
              ? UPDATED_NOTE
              : ""}
      </p>
      {blocked !== undefined && (
        <p role="note" className="text-muted-foreground text-xs">
          {blocked}
        </p>
      )}
      {state.status === "error" && <ErrorNotice error={state.error} />}
      {outside.mode !== null && (
        <OutsideChoices
          mode={outside.mode}
          busy={state.status === "saving"}
          comparing={outside.comparing}
          onCompare={outside.toggleCompare}
          onKeepMine={() => void outside.keepMine(current)}
          onTakeTheirs={outside.takeTheirs}
        />
      )}
      {outside.error && <ErrorNotice error={outside.error} />}
      {outside.comparing && draft !== undefined ? (
        <CompareView
          api={props.api}
          path={path}
          name={name}
          draft={current}
          onDraft={edit}
          onTheirs={outside.setTheirs}
        />
      ) : (
        <TextModeBody
          mode={mode}
          text={current}
          preview={previewOf(path)}
          label={`Edit ${name}`}
          readOnly={blocked !== undefined}
          onChange={edit}
        />
      )}
    </div>
  );
}

/**
 * The banner and conflict choices (KOBE-491). The agent's version is named once: by Compare's
 * read, by the change that raised the banner, or by a version read when a save was refused; Keep
 * mine saves over exactly that version, so a newer change is refused again, never overwritten.
 */
function useOutsideChoices(
  props: FileEditorProps,
  draft: { readonly text: string } | undefined,
  state: SaveState,
  saver: Pick<ReturnType<typeof useSave>, "save" | "reset">,
) {
  const { api, path, drafts, outside } = props;
  const [comparing, setComparing] = useState(false);
  const [theirs, setTheirs] = useState<{ readonly sha256: string } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const conflict = state.status === "conflict";
  const banner = outside?.kind === "changed" && draft !== undefined;
  // A refused save: name the version that is there now.
  useEffect(() => {
    if (!conflict) return;
    let current = true;
    void fileVersion(api, path).then((v) => {
      if (current && v.kind === "version") setTheirs((t) => t ?? { sha256: v.sha256 });
    });
    return () => {
      current = false;
    };
  }, [conflict, api, path]);
  const done = () => {
    setComparing(false);
    setTheirs(null);
    setError(null);
  };
  const keepMine = async (text: string) => {
    setError(null);
    if (!conflict) {
      // The banner's Keep mine: nothing is saved yet; Save asks again.
      setComparing(false);
      props.onOutsideDismiss?.();
      return;
    }
    const base = theirs?.sha256 ?? (outside?.kind === "changed" ? outside.sha256 : undefined);
    if (base === undefined) return;
    const result = await saver.save(base, text);
    if (result === "saved") {
      done();
      props.onOutsideDismiss?.();
      return;
    }
    if (result !== "conflict") return;
    // It changed again since that version: say so, and name the newest for the next Keep mine.
    setError(CHANGED_AGAIN);
    const latest = await fileVersion(api, path);
    setTheirs(latest.kind === "version" ? { sha256: latest.sha256 } : null);
  };
  const takeTheirs = () => {
    if (!window.confirm(TAKE_THEIRS_PROMPT(fileName(path)))) return;
    drafts.clear(path);
    done();
    saver.reset();
    props.onReload();
  };
  return {
    mode: conflict ? ("conflict" as const) : banner ? ("banner" as const) : null,
    comparing: comparing && (conflict || banner),
    toggleCompare: () => setComparing((c) => !c),
    setTheirs,
    keepMine,
    takeTheirs,
    error,
  };
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
