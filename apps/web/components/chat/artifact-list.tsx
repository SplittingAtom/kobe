"use client";

/**
 * The thread's artifacts and agent-written files as badges under its title (KOBE-130, KOBE-488):
 * how an old thread's work is reopened. The artifacts (`GET /v1/artifacts?thread_id=`) and files
 * (`GET /v1/threads/{id}/files`, the owner only) are read by the artifact column's state
 * (`artifact-state.tsx`), again when the live run reports an artifact or a write. An artifact opens
 * its artifact tab, a file its file tab (text in the editor, other types in their viewers).
 */
import { FileIcon, LayersIcon, type LucideIcon } from "lucide-react";
import { fileTabId } from "../../lib/files/preview";
import { useArtifactPanel } from "./artifact-state";

const BADGE =
  "hover:bg-muted inline-flex max-w-60 min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs";

function Badge({
  icon: Icon,
  label,
  text,
  title,
  open,
  onClick,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly text: string;
  readonly title: string;
  readonly open: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={BADGE}
      aria-label={label}
      title={title}
      aria-expanded={open}
      onClick={onClick}
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{text}</span>
    </button>
  );
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function ArtifactList() {
  const panel = useArtifactPanel();
  const artifacts = panel?.artifacts ?? [];
  const files = panel?.files ?? [];
  if (!panel || artifacts.length + files.length === 0) return null;
  return (
    <nav
      aria-label="Artifacts and files in this conversation"
      className="flex flex-wrap gap-2 px-4 pb-2"
    >
      {artifacts.map((a) => (
        <Badge
          key={a.id}
          icon={LayersIcon}
          label={`Open artifact ${a.title}`}
          text={a.title}
          title={a.title}
          open={panel.openId === a.id}
          onClick={() => panel.openArtifact(a.id)}
        />
      ))}
      {files.map((f) => (
        <Badge
          key={f.path}
          icon={FileIcon}
          label={`Open file ${f.path}`}
          text={baseName(f.path)}
          title={f.path}
          open={panel.openId === fileTabId(f.path)}
          onClick={() => panel.openFile(f.path)}
        />
      ))}
    </nav>
  );
}
