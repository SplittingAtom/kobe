"use client";

import type { ThreadBranchesResponse, ThreadLineageResponse } from "@kobe/protocol";
import { createContext, useContext } from "react";

/**
 * What the Conversation tree (CT4, KOBE-546) shares with the conversation: the `branches` read
 * (labels for the tree and the branch picker), the lineage (forks), and opening the panel. One
 * host per thread view: the workspace's, at `/tree` (`route`), or a test pane's own, in memory.
 */
export interface TreeData {
  readonly notes: ThreadBranchesResponse;
  /** A label write's answer: the store becomes that body. */
  readonly replaceNotes: (notes: ThreadBranchesResponse) => void;
  readonly lineage: ThreadLineageResponse | null;
  /** Labels by the chat's message id (the picker: "Version 2 of 3 · label"). */
  readonly labelOf: (messageId: string) => string | undefined;
  /** Opens the panel; null where there is no thread yet (a draft). */
  readonly open: (() => void) | null;
  /** Opens Compare versions (CT10, KOBE-547) on a message with other versions. */
  readonly compare: (messageId: string) => void;
  /** The message the palette's message actions act on: the last one focused or hovered. */
  readonly focusedMessage: { current: string | null };
}

export const TreeContext = createContext<TreeData | null>(null);

export function useTreeData(): TreeData | null {
  return useContext(TreeContext);
}
