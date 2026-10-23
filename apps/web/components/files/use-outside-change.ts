"use client";

/**
 * What an open text tab does when its file changed outside it (KOBE-491). On each change hint the
 * tab's `VersionWatch` compares the synced version with the one it shows. Without a draft the tab
 * re-reads in place and is `updated`; with a draft nothing is replaced and the tab is `changed`
 * (the editor's banner: Compare, Keep mine, Take theirs). Keep mine dismisses that version's
 * banner; once the draft is gone (saved, discarded, Take theirs) a pending change is read in.
 * A file gone from the workspace closes a clean tab (the read says so); a draft keeps it open.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { FilesApi } from "../../lib/files/api";
import type { EditDraftStore } from "../../lib/files/editor-state";
import { fileVersion, VersionWatch } from "../../lib/files/outside-change";
import type { ChangeHint } from "../chat/use-file-change-hint";
import { useDraft } from "./file-editor";

export type OutsideChange =
  /** Read in place: the tab now shows the agent's version `sha256`. */
  | { readonly kind: "updated"; readonly sha256: string }
  /** The member has a draft: version `sha256` is waiting, nothing was replaced. */
  | { readonly kind: "changed"; readonly sha256: string };

export interface OutsideChangeOptions {
  readonly api: FilesApi;
  readonly path: string;
  /** The version the tab shows (undefined: not a checkable text file). */
  readonly known: string | undefined;
  readonly hint: ChangeHint | null | undefined;
  readonly drafts: EditDraftStore | undefined;
  reread(): void;
}

export function useOutsideChange(options: OutsideChangeOptions) {
  const { api, path, known, hint, drafts, reread } = options;
  const [outside, setOutside] = useState<OutsideChange | null>(null);
  const knownRef = useRef(known);
  knownRef.current = known;
  const dismissed = useRef<string | null>(null);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const rereadRef = useRef(reread);
  rereadRef.current = reread;

  const [watch, setWatch] = useState<VersionWatch | null>(null);
  useEffect(() => {
    const next = new VersionWatch({
      check: (signal) => fileVersion(api, path, signal),
      known: () => knownRef.current,
      onChange: (result) => {
        const dirty = draftsRef.current?.get(path) !== undefined;
        if (result.kind === "gone") {
          if (!dirty) rereadRef.current(); // the read finds it gone and closes the tab
          return;
        }
        if (!dirty) {
          setOutside((o) => same(o, "updated", result.sha256));
          rereadRef.current();
        } else if (dismissed.current !== result.sha256) {
          setOutside((o) => same(o, "changed", result.sha256));
        }
      },
    });
    setWatch(next);
    return () => next.dispose();
  }, [api, path]);

  useEffect(() => {
    if (hint && watch) watch.hint(hint.delays, { oneShot: hint.oneShot === true });
  }, [hint, watch]);

  // The draft went away (saved, discarded, Take theirs) while a change waited: read it in.
  const draft = useDraft(drafts ?? NO_DRAFTS, path);
  useEffect(() => {
    if (draft !== undefined || outside?.kind !== "changed") return;
    if (known === outside.sha256) setOutside(null);
    else {
      setOutside((o) => same(o, "updated", outside.sha256));
      rereadRef.current();
    }
  }, [draft, outside, known]);

  /** Keep mine: this version's banner stays dismissed; Save then names the choice again. */
  const dismiss = useCallback(() => {
    if (outside) dismissed.current = outside.sha256;
    setOutside(null);
  }, [outside]);
  return { outside, dismiss };
}

/** The current state when it already says this (no new object, no re-render). */
function same(
  current: OutsideChange | null,
  kind: OutsideChange["kind"],
  sha256: string,
): OutsideChange {
  return current?.kind === kind && current.sha256 === sha256 ? current : { kind, sha256 };
}

const NO_DRAFTS = {
  subscribe: () => () => {},
  get: () => undefined,
} as unknown as EditDraftStore;
