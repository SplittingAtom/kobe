"use client";

import { useEffect, useState, type MouseEvent } from "react";
import type { ApiError } from "../../lib/api/client";
import { newPathProblem } from "../../lib/skills/paths";
import { Button, Field, Textarea, TextInput, useUnsavedChanges } from "../ui/console";
import { ErrorNotice } from "../admin/error-notice";

/**
 * Create file (KOBE-478): a new text file's path (folders included) and contents in the editor
 * rail, like a file's own edit view. Save checks the path with the package rules, then writes it
 * as a draft file the way Add file and autosave do, so the server's limits, lint and the scan
 * apply as to any other file. Nothing is written before Save. Once something is typed it reports
 * itself dirty (`onDirtyChange`): the page asks before Cancel or another file drops it, the
 * Skills panel asks before closing, and closing the browser tab asks too.
 */
export function NewFileEditor({
  initialPath,
  paths,
  onSave,
  onSaved,
  onCancel,
  onDirtyChange,
}: {
  /** The path field's start: a folder's `name/`, or empty. */
  readonly initialPath: string;
  /** The draft's paths now. */
  readonly paths: readonly string[];
  readonly onSave: (path: string, text: string) => Promise<ApiError | null>;
  readonly onSaved: (path: string) => void;
  readonly onCancel: (e: MouseEvent<HTMLButtonElement>) => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
}) {
  const [path, setPath] = useState(initialPath);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = text !== "" || path !== initialPath;
  useUnsavedChanges(dirty);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  return (
    <form
      noValidate
      aria-label="Create file"
      className="grid gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const trimmed = path.trim();
        const why = newPathProblem(trimmed, paths);
        setProblem(why);
        setFailure(null);
        if (why) return;
        setBusy(true);
        const err = await onSave(trimmed, text);
        setBusy(false);
        if (err) setFailure(err);
        else onSaved(trimmed);
      }}
    >
      <Field
        label="New file path"
        hint="Folders before the name, for example references/guide.md"
        error={problem ?? undefined}
      >
        <TextInput
          type="text"
          className="w-full font-mono"
          value={path}
          autoFocus
          onChange={(e) => setPath(e.target.value)}
        />
      </Field>
      <Field label="New file contents">
        <Textarea
          className="min-h-80 w-full resize-y font-mono"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
      {failure && <ErrorNotice error={failure} />}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={busy}>
          Save file
        </Button>
        <Button type="button" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
