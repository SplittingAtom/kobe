"use client";

/**
 * The thread's artifacts as buttons under its title (KOBE-130): how an old thread's artifacts are
 * reopened (`GET /v1/artifacts?thread_id=`). Read again when the live run reports an artifact.
 */
import { useEffect, useState } from "react";
import type { ArtifactSummaryView } from "../../lib/chat/artifacts";
import { useArtifactEventCount, useArtifactPanel } from "./artifact-panel";
import { useChatSession } from "./kobe-runtime";

export function ArtifactList({ threadId }: { readonly threadId: string | null }) {
  const session = useChatSession();
  const panel = useArtifactPanel();
  const events = useArtifactEventCount();
  const [artifacts, setArtifacts] = useState<readonly ArtifactSummaryView[]>([]);
  useEffect(() => {
    if (threadId === null) {
      setArtifacts([]);
      return;
    }
    let current = true;
    void session.api.listArtifacts(threadId).then((res) => {
      // A failed list only means no shortcuts; the notice and tool card still open artifacts.
      if (current) setArtifacts(res.ok ? res.data.artifacts : []);
    });
    return () => {
      current = false;
    };
  }, [session, threadId, events]);
  if (!panel || artifacts.length === 0) return null;
  return (
    <nav aria-label="Artifacts in this conversation" className="flex flex-wrap gap-2 px-4 pb-2">
      {artifacts.map((a) => (
        <button
          key={a.id}
          type="button"
          className="hover:bg-muted max-w-60 truncate rounded-full border px-2 py-0.5 text-xs"
          aria-expanded={panel.openId === a.id}
          onClick={() => panel.openArtifact(a.id)}
        >
          {a.title}
        </button>
      ))}
    </nav>
  );
}
