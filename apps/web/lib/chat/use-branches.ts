"use client";

/**
 * The `branches` read of the thread on screen (CT2, KOBE-545), with the lineage's triggers (TL4,
 * {@link useFocusReread}) plus `refresh` after a label change. A failed read keeps the last good
 * notes; with none yet the notes are empty (no labels, no rule badges, no error box). `source`
 * must be stable (the chat session).
 */
import type { ThreadBranchesResponse } from "@kobe/protocol";
import { BRANCHES_REREAD_MS, EMPTY_BRANCHES } from "./branches";
import { useFocusReread } from "./use-focus-reread";

export interface BranchesSource {
  readonly api: {
    readonly getThreadBranches: (threadId: string) => Promise<ThreadBranchesResponse | null>;
  };
}

export interface Branches {
  /** The last good read for the thread on screen, else empty. */
  readonly notes: ThreadBranchesResponse;
  /** Read again now (after a label change). */
  readonly refresh: () => void;
  /** A label write's answer (CT9, KOBE-546): the store becomes that body, no read again. */
  readonly replace: (notes: ThreadBranchesResponse) => void;
}

const readBranches = (source: BranchesSource, threadId: string) =>
  source.api.getThreadBranches(threadId);

export function useBranches(
  threadId: string | null,
  source: BranchesSource | null,
  now: () => number = Date.now,
): Branches {
  const { value, refresh, replace } = useFocusReread(threadId, source, readBranches, {
    rereadMs: BRANCHES_REREAD_MS,
    now,
    keepOnFailure: true,
  });
  return { notes: value ?? EMPTY_BRANCHES, refresh, replace };
}
