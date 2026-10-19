"use client";

import { useState } from "react";
import type { ApiError } from "../../lib/api/client";
import type { DraftFileInfo } from "../../lib/skills/drafts-api";
import { newPathProblem } from "../../lib/skills/paths";
import { SKILL_MD } from "../../lib/skills/skill-md";
import { cn } from "../../lib/utils";
import { Button, Field, FOCUS_RING, TextInput } from "../ui/console";
import { ErrorNotice } from "../admin/error-notice";

/** The folder a path sits in ("" for the root). */
const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Root files first (SKILL.md on top), then each folder's files under its name. */
function grouped(files: readonly DraftFileInfo[]): [string, DraftFileInfo[]][] {
  const groups = new Map<string, DraftFileInfo[]>();
  const sorted = [...files].sort((a, b) =>
    a.path === SKILL_MD ? -1 : b.path === SKILL_MD ? 1 : a.path.localeCompare(b.path),
  );
  for (const f of sorted) {
    const folder = folderOf(f.path);
    groups.set(folder, [...(groups.get(folder) ?? []), f]);
  }
  return [...groups.entries()].sort(([a], [b]) =>
    a === "" ? -1 : b === "" ? 1 : a.localeCompare(b),
  );
}

/**
 * The draft's files (KOBE-321, SK12): pick one to edit; add a text file by its path (checked with
 * the package rules before it is sent).
 */
export function FileTree({
  files,
  selected,
  onSelect,
  onAdd,
}: {
  readonly files: readonly DraftFileInfo[];
  readonly selected: string;
  readonly onSelect: (path: string) => void;
  readonly onAdd: (path: string) => Promise<ApiError | null>;
}) {
  const [path, setPath] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <nav aria-label="Files" className="min-w-0">
      {grouped(files).map(([folder, inFolder]) => (
        <div key={folder || "/"} className="mb-2">
          {folder && <p className="m-0 mb-1 text-sm font-semibold text-console-muted">{folder}/</p>}
          <ul className="m-0 list-none p-0">
            {inFolder.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  aria-current={f.path === selected ? "true" : undefined}
                  aria-label={f.kind === "binary" ? `${f.path} (binary)` : f.path}
                  onClick={() => onSelect(f.path)}
                  className={cn(
                    "m-0 box-border w-full cursor-pointer truncate rounded border-0 bg-transparent px-2 py-1 text-start text-sm text-console-fg hover:bg-console-panel aria-[current=true]:bg-console-panel aria-[current=true]:font-semibold",
                    folder && "ps-4",
                    FOCUS_RING,
                  )}
                >
                  {nameOf(f.path)}
                  {f.kind === "binary" && <span className="text-console-muted"> (binary)</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <form
        noValidate
        className="mt-3 grid gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const trimmed = path.trim();
          const why = newPathProblem(
            trimmed,
            files.map((f) => f.path),
          );
          setProblem(why);
          setFailure(null);
          if (why) return;
          setBusy(true);
          const err = await onAdd(trimmed);
          setBusy(false);
          if (err) setFailure(err);
          else {
            setPath("");
            onSelect(trimmed);
          }
        }}
      >
        <Field label="New file" hint="For example references/guide.md" error={problem ?? undefined}>
          <TextInput
            type="text"
            className="w-full"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
        </Field>
        <div>
          <Button type="submit" size="sm" disabled={busy}>
            Add file
          </Button>
        </div>
        {failure && <ErrorNotice error={failure} />}
      </form>
    </nav>
  );
}
