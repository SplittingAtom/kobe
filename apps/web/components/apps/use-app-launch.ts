"use client";

import { useAui, useAuiState } from "@assistant-ui/react";
import { useCallback, useContext, useState } from "react";
import { launchAppCard, type RailApp } from "../../lib/apps/app-cards";
import { ChatSessionContext, useKobeExtras } from "../chat/kobe-runtime";

/**
 * Launches an app into the conversation on screen exactly as the rail's Apps section does
 * (KOBE-440, spec MA3, MA11): the member's own live thread takes the card (queued as a chip
 * during a run); a new-thread view, a thread shared read-only or one in Trash gets a new thread.
 * The server calls the app's opening tool as the member and re-checks the app on insert. Used by
 * the composer's + menu (KOBE-451); the rail keeps its own copy (it also closes its drawer).
 */
export function useAppLaunch(): {
  readonly busy: string | null;
  readonly error: string | null;
  launch(app: RailApp): Promise<boolean>;
} {
  const aui = useAui();
  const session = useContext(ChatSessionContext);
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const summary = useKobeExtras()?.state.summary;
  const own = summary?.readOnly !== true && (summary?.deletedAt ?? null) === null;
  const target = remoteId !== undefined && own ? remoteId : null;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const launch = useCallback(
    async (app: RailApp) => {
      if (!session || busy !== null) return false;
      setBusy(app.appId);
      setError(null);
      const res = await launchAppCard(target, app.appId, session.teamId);
      setBusy(null);
      if (!res.ok) {
        setError(res.error.message);
        return false;
      }
      if (target === null) {
        session.threadCreated();
        aui.threads.switchToThread(res.data.threadId);
      } else {
        session.appCards.changed(target);
      }
      return true;
    },
    [session, busy, target, aui],
  );
  return { busy, error, launch };
}
