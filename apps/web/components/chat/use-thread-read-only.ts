"use client";

import { useAuiState } from "@assistant-ui/react";
import { useSyncExternalStore } from "react";
import { threadReadOnly } from "../../lib/chat/thread-commands";
import { useChatSession } from "./kobe-runtime";

const noSubscribe = () => () => {};

/**
 * Whether the viewer only reads the open thread (KOBE-221), by the one rule the row menu and the
 * open thread's bindings use (`threadReadOnly`): listed as shared with them, or so its summary
 * says once read (a deep link to a shared thread the list has not shown). For the palette and
 * the shortcuts (KOBE-225), which sit outside the thread view.
 */
export function useThreadReadOnly(): boolean {
  const session = useChatSession();
  const custom = useAuiState((s) => s.threadListItem.custom);
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const controller = remoteId === undefined ? undefined : session.peek(remoteId);
  const summaryReadOnly = useSyncExternalStore(
    controller?.subscribe ?? noSubscribe,
    () => controller?.getState().summary?.readOnly === true,
    () => false,
  );
  return threadReadOnly(custom, undefined) || summaryReadOnly;
}
