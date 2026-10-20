"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * What a search hit adds under its thread row in the Threads panel (KOBE-453): where it matched,
 * and that it is archived, by the thread's id. Empty outside a search.
 */
export const HitNotes = createContext<ReadonlyMap<string, ReactNode> | null>(null);

/** The note under a thread row for a search hit, if any. */
export function useHitNote(remoteId: string | undefined): ReactNode {
  const notes = useContext(HitNotes);
  return remoteId === undefined ? null : (notes?.get(remoteId) ?? null);
}
