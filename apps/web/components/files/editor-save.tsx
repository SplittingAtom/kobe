"use client";

/**
 * The file editor's shared state hooks (KOBE-463; split out in KOBE-615): a file's draft and
 * review from the session's stores, and one save at a version with its notices. The editor, the
 * proposal review and the notebook all save through `useSave`.
 */
import { useState, useSyncExternalStore } from "react";
import type { ApiError } from "../../lib/api/client";
import type { FilesApi } from "../../lib/files/api";
import { sha256Hex } from "../../lib/files/editor";
import type { EditDraftStore, FileReviewStore } from "../../lib/files/editor-state";
import { describeFileError } from "../../lib/files/format";
import { ErrorNotice } from "../admin/error-notice";
import { BUTTON } from "./text-modes";

export const CONFLICT_NOTICE =
  "This file changed since it was opened here (another save, or the agent), so nothing was saved.";

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
