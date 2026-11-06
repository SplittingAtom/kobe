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
  /**
   * Opens Compare versions (CT10, KOBE-547) on a message with other versions: `picked` starts
   * from that message (the tree's menu, the palette's focused message), else the two newest.
   */
  readonly compare: (messageId: string, picked?: boolean) => void;
  /** The message the palette's message actions act on: the last one focused or hovered. */
  readonly focusedMessage: FocusedMessage;
}

/** The last message focused or hovered; the palette's bindings follow it (`subscribe`). */
export interface FocusedMessage {
  current: string | null;
  readonly subscribe: (listener: () => void) => () => void;
}

/** A focused-message store: setting `current` to another message tells the listeners. */
export function focusedMessageStore(): FocusedMessage {
  let value: string | null = null;
  const listeners = new Set<() => void>();
  return {
    get current() {
      return value;
    },
    set current(next: string | null) {
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const TreeContext = createContext<TreeData | null>(null);

export function useTreeData(): TreeData | null {
  return useContext(TreeContext);
}
