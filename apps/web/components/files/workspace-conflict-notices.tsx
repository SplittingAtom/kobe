"use client";

/**
 * Sync conflicts no thread wrote (KOBE-492: no run of the member's wrote the path, so no thread can
 * show them) in the Files rail, with the same notice and actions as in a thread. Read whenever the
 * rail lists the workspace (shown, Refresh, /files); a failed read shows none.
 */
import { useCallback, useContext, useEffect, useState } from "react";
import type { FilesApi } from "../../lib/files/api";
import type { SyncConflictView } from "../../lib/files/sync-conflicts";
import { ChatSessionContext } from "../chat/kobe-runtime";
import { ConflictNotice } from "./sync-conflict-notice";

const NONE: readonly SyncConflictView[] = [];

export function WorkspaceConflictNotices({
  api,
  readKey,
}: {
  readonly api: FilesApi;
  /** Changes whenever the rail lists the workspace again: the conflicts are read again too. */
  readonly readKey: number;
}) {
  const session = useContext(ChatSessionContext);
  const [conflicts, setConflicts] = useState<readonly SyncConflictView[]>(NONE);
  useEffect(() => {
    let current = true;
    void api.syncConflicts().then((res) => {
      if (current) setConflicts(res.ok ? res.data.conflicts : NONE);
    });
    return () => {
      current = false;
    };
  }, [api, readKey]);
  const settle = useCallback(
    async (id: string, action: "resolved" | "dismissed") => {
      const before = conflicts;
      setConflicts((list) => list.filter((c) => c.id !== id));
      const res = await api.settleSyncConflict(id, action);
      if (!res.ok) setConflicts(before);
      return res.ok;
    },
    [api, conflicts],
  );
  if (conflicts.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 px-2 pb-2" data-kobe-workspace-conflicts>
      {conflicts.map((c) => (
        <ConflictNotice
          key={c.id}
          conflict={c}
          readOnly={false}
          settle={settle}
          files={api}
          reviews={session?.fileReviews}
        />
      ))}
    </div>
  );
}
