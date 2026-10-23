"use client";

/**
 * Workspace sync conflict notices (KOBE-492) above the composer: "The agent's change to notes.md
 * conflicted with your save. Your version was kept; the agent's is in notes.conflict-….md", with
 * Open both (a tab for each file), Compare (the file editor's inline diff: your file against the
 * agent's copy, whose changes you can take chunk by chunk), Delete the copy (asks first; the
 * workspace delete, then the notice is resolved) and Dismiss. The thread's owner only: the list is
 * theirs alone, and a shared reader (read-only thread) never gets actions.
 */
import { GitCompareIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { TEXT_PREVIEW_MAX_BYTES, fileName } from "../../lib/files/preview";
import {
  conflictNoticeText,
  conflictReview,
  type SyncConflictView,
} from "../../lib/files/sync-conflicts";
import type { FilesApi } from "../../lib/files/api";
import type { FileReviewStore } from "../../lib/files/editor-state";
import { useArtifactPanel } from "../chat/artifact-state";
import { useChatSession, useKobeExtras } from "../chat/kobe-runtime";
import { useSyncConflicts } from "../chat/use-sync-conflicts";

const BUTTON = "hover:bg-muted rounded-md border px-2 py-0.5 text-xs";

export const COMPARE_TOO_LARGE =
  "The agent's copy is too large to compare here. Open both instead.";
export const COMPARE_FAILED = "The agent's copy could not be read. Try again, or open both.";
export const DELETE_FAILED = "The copy could not be deleted. Try again.";

export function SyncConflictNotices() {
  const extras = useKobeExtras();
  const threadId = extras?.state.threadId ?? undefined;
  const readOnly = extras?.state.summary?.readOnly === true;
  const { conflicts, settle } = useSyncConflicts(threadId);
  const session = useChatSession();
  if (conflicts.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-kobe-sync-conflicts>
      {conflicts.map((c) => (
        <ConflictNotice
          key={c.id}
          conflict={c}
          readOnly={readOnly}
          settle={settle}
          files={session.files}
          reviews={session.fileReviews}
        />
      ))}
    </div>
  );
}

/**
 * One notice. Used above the composer (a thread's conflicts) and in the Files rail (conflicts no
 * thread wrote, `workspace-conflict-notices.tsx`). Without a review store there is no Compare;
 * without an artifact column, no Open both.
 */
export function ConflictNotice({
  conflict,
  readOnly,
  settle,
  files,
  reviews,
}: {
  readonly conflict: SyncConflictView;
  readonly readOnly: boolean;
  settle(id: string, action: "resolved" | "dismissed"): Promise<boolean>;
  readonly files: FilesApi;
  readonly reviews?: FileReviewStore | undefined;
}) {
  const panel = useArtifactPanel();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const copyName = fileName(conflict.conflictPath);

  const openBoth = () => {
    panel?.openFile(conflict.conflictPath);
    panel?.openFile(conflict.path);
  };

  const compare = async () => {
    setProblem(null);
    setBusy(true);
    const res = await files.read(conflict.conflictPath, TEXT_PREVIEW_MAX_BYTES);
    setBusy(false);
    if (!res.ok) return setProblem(COMPARE_FAILED);
    if (res.data.truncated) return setProblem(COMPARE_TOO_LARGE);
    const text = new TextDecoder().decode(res.data.bytes);
    reviews?.start(conflictReview(conflict, text));
    panel?.openFile(conflict.path);
  };

  const deleteCopy = async () => {
    setProblem(null);
    setBusy(true);
    const res = await files.remove(conflict.conflictPath);
    setBusy(false);
    // Already gone counts as deleted.
    if (!res.ok && res.error.status !== 404) return setProblem(DELETE_FAILED);
    setConfirming(false);
    panel?.dropFile(conflict.conflictPath);
    await settle(conflict.id, "resolved");
  };

  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border px-3 py-2 text-sm"
      data-kobe-sync-conflict={conflict.path}
    >
      <GitCompareIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="flex flex-1 flex-col gap-1">
        <p>{conflictNoticeText(conflict)}</p>
        {!readOnly && !confirming && (
          <div className="flex flex-wrap gap-1">
            {panel && (
              <button type="button" className={BUTTON} onClick={openBoth}>
                Open both
              </button>
            )}
            {panel && reviews && (
              <button
                type="button"
                className={BUTTON}
                disabled={busy}
                onClick={() => void compare()}
              >
                Compare
              </button>
            )}
            <button
              type="button"
              className={BUTTON}
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              Delete the copy
            </button>
          </div>
        )}
        {confirming && (
          <div role="group" aria-label={`Delete ${copyName}?`} className="flex flex-wrap gap-1">
            <span className="me-1">Delete {copyName}? The agent&apos;s version is lost.</span>
            <button
              type="button"
              className={BUTTON}
              disabled={busy}
              onClick={() => void deleteCopy()}
            >
              Delete
            </button>
            <button type="button" className={BUTTON} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        )}
        {problem !== null && (
          <p role="alert" className="text-xs">
            {problem}
          </p>
        )}
      </div>
      {!readOnly && (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground rounded p-0.5"
          aria-label={`Dismiss the conflict notice for ${fileName(conflict.path)}`}
          title="Dismiss"
          onClick={() => void settle(conflict.id, "dismissed")}
        >
          <XIcon aria-hidden className="size-3.5" />
        </button>
      )}
    </div>
  );
}
