"use client";

import { useAuiState } from "@assistant-ui/react";
import { isStopping } from "../../lib/chat/thread-state";
import { kobeExtrasOf } from "./kobe-runtime";

/**
 * Whether a part is being written, for the arrival fade (KOBE-207): it streams, and Stop was not
 * accepted for its run (KOBE-269: the run's end can arrive seconds after Stop; nothing fades meanwhile).
 */
export function useArriving(status: { readonly type: string }): boolean {
  const stopping = useAuiState((s) => {
    const extras = kobeExtrasOf(s);
    return extras ? isStopping(extras.state) : false;
  });
  return status.type === "running" && !stopping;
}
