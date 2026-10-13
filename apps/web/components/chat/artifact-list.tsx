"use client";

/**
 * The thread's artifacts as buttons under its title (KOBE-130): how an old thread's artifacts are
 * reopened. The list (`GET /v1/artifacts?thread_id=`) is read by the artifact column's state
 * (`artifact-state.tsx`), again when the live run reports an artifact.
 */
import { useArtifactPanel } from "./artifact-state";

export function ArtifactList() {
  const panel = useArtifactPanel();
  const artifacts = panel?.artifacts ?? [];
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
