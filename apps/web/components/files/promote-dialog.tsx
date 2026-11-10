"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { FileEntry } from "../../lib/files/api";
import type { Project, ProjectsApi } from "../../lib/projects/api";
import { PROMOTE_NAME_MAX, promoteNameProblem } from "../../lib/projects/promote";

const BUTTON = "rounded-md border px-2 py-0.5 text-xs";

/**
 * Promote to project… (KOBE-586, projects-in-conversations PF2): one field, the project's name,
 * prefilled with the folder's. The folder's files become the project's first commit and the
 * folder leaves My files; description, instructions and members are set on the project page.
 * The server's refusals (limits, quota, permission) show here, and nothing has changed then.
 * Inline like the panel's other dialogs: it takes the focus, Escape cancels.
 */
export function PromoteDialog({
  entry,
  api,
  onDone,
  onCancel,
}: {
  readonly entry: FileEntry;
  readonly api: Pick<ProjectsApi, "promoteFolder">;
  onDone(project: Project): void;
  onCancel(): void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(entry.name);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const issue = promoteNameProblem(name);
    setProblem(issue);
    if (issue !== null) return input.current?.focus();
    setBusy(true);
    const res = await api.promoteFolder(entry.path, name);
    setBusy(false);
    if (!res.ok) {
      setProblem(res.error.message);
      return input.current?.focus();
    }
    onDone(res.data);
  };

  return (
    <div
      role="dialog"
      aria-labelledby={`${id}-t`}
      aria-describedby={`${id}-h`}
      className="border-border mt-1 flex flex-col gap-1.5 rounded-md border p-2 text-xs"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <form className="flex flex-col gap-1.5" onSubmit={(e) => void submit(e)}>
        <p id={`${id}-t`} className="m-0 font-medium">
          {`Promote ${entry.name} to a project`}
        </p>
        <p id={`${id}-h`} className="text-muted-foreground m-0">
          Its files move into a new project you own, as its first commit, and the folder leaves My
          files. Add a description, instructions and members on the project page.
        </p>
        <label htmlFor={`${id}-i`}>Project name</label>
        <input
          ref={input}
          id={`${id}-i`}
          value={name}
          maxLength={PROMOTE_NAME_MAX + 20}
          disabled={busy}
          aria-invalid={problem !== null}
          aria-describedby={problem ? `${id}-p` : undefined}
          className="border-input bg-background rounded-md border px-1.5 py-0.5 text-sm"
          onChange={(e) => setName(e.currentTarget.value)}
        />
        {problem && (
          <p id={`${id}-p`} role="alert" className="text-destructive m-0">
            {problem}
          </p>
        )}
        {busy && (
          <p role="status" className="text-muted-foreground m-0">
            Creating the project…
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={BUTTON} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className={BUTTON} disabled={busy}>
            Promote
          </button>
        </div>
      </form>
    </div>
  );
}
