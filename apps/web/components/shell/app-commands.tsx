"use client";

import { useAui } from "@assistant-ui/react";
import { useBindCommands } from "./command-bindings";
import { useRail } from "./rail-state";

/**
 * The workspace's own actions for the command listings (KOBE-224), bound once for the chat
 * whatever the layout shows (collapsed rail, drawer, one column): New conversation (what
 * `ThreadListPrimitive.New` calls) and Files (what the bar's Files button calls).
 */
export function AppCommands() {
  const aui = useAui();
  const rail = useRail();
  useBindCommands({
    "new-thread": { onSelect: () => aui.threads.switchToNewThread() },
    ...(rail ? { files: { onSelect: () => rail.reveal("files") } } : {}),
  });
  return null;
}
