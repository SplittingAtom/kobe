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
      // From the new-conversation view the thread starts with its choices (KOBE-458).
      const draft = target === null && remoteId === undefined ? session.launchDraft() : undefined;
      const res = await launchAppCard(target, app.appId, session.teamId, undefined, draft);
      setBusy(null);
      if (!res.ok) {
        setError(res.error.message);
        return false;
      }
      if (target === null) {
        if (draft) session.launchDraftTaken();
        session.threadCreated();
        aui.threads.switchToThread(res.data.threadId);
      } else {
        session.appCards.changed(target);
      }
      return true;
    },
    [session, busy, target, remoteId, aui],
  );
  return { busy, error, launch };
}
