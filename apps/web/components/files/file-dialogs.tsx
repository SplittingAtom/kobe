"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { mentionPathIssue } from "@kobe/protocol";
import type { FileEntry } from "../../lib/files/api";
import { parentPath } from "../../lib/files/format";
import { canMoveInto, joinPath } from "../../lib/files/tree";

/**
 * The Files panel's inline dialogs (KOBE-292 delete, KOBE-304 rename and move): each takes the
 * focus when it opens, Escape cancels, and the panel gives the focus back to the row.
 */

const BUTTON = "rounded-md border px-2 py-0.5 text-xs";

function Inline({
  role,
  labelId,
  onCancel,
  children,
}: {
  readonly role: "dialog" | "alertdialog";
  readonly labelId: string;
  onCancel(): void;
  readonly children: ReactNode;
}) {
  return (
    <div
      role={role}
      aria-labelledby={labelId}
      className="border-border mt-1 flex flex-col gap-1.5 rounded-md border p-2 text-xs"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      {children}
    </div>
  );
}

export function ConfirmDelete({
  entry,
  busy,
  onConfirm,
  onCancel,
}: {
  readonly entry: FileEntry;
  readonly busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div
      role="alertdialog"
      aria-labelledby="kobe-files-confirm"
      className="border-destructive/40 mt-1 flex flex-wrap items-center gap-2 rounded-md border p-2 text-xs"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <p id="kobe-files-confirm" className="m-0 min-w-0 flex-1">
        {entry.type === "dir"
          ? `Delete the folder ${entry.name} and everything in it? This cannot be undone.`
          : `Delete ${entry.name}? This cannot be undone.`}
      </p>
      <button type="button" ref={cancel} className={BUTTON} onClick={onCancel}>
        Cancel
      </button>
      <button
        type="button"
        className={`${BUTTON} text-destructive border-destructive/40`}
        disabled={busy}
        onClick={onConfirm}
      >
        Delete
      </button>
    </div>
  );
}

/** Why `name` can't be the new name, or null (the server checks again; KOBE-223 rules). */
export function nameProblem(entry: FileEntry, name: string): string | null {
  if (name === "" || name.trim() === "") return "Type a name.";
  if (name.includes("/")) return "A name can't contain /. Use Move to… to change the folder.";
  if (name === "." || name === "..") return "That name is not allowed.";
  if (name === entry.name) return "That is its name already.";
  if (mentionPathIssue(joinPath(parentPath(entry.path), name)) !== undefined) {
    return "Names may not hold invisible, control or format characters, `, $ or ;, or spaces other than the plain space.";
  }
  return null;
}

export function RenameForm({
  entry,
  busy,
  onRename,
  onCancel,
}: {
  readonly entry: FileEntry;
  readonly busy: boolean;
  onRename(name: string): void;
  onCancel(): void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(entry.name);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    // The name without its extension is selected, as in a desktop file manager.
    const dot = entry.type === "file" ? entry.name.lastIndexOf(".") : -1;
    el.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
  }, [entry]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const issue = nameProblem(entry, name);
    setProblem(issue);
    if (issue === null) onRename(name);
  };
  return (
    <Inline role="dialog" labelId={`${id}-t`} onCancel={onCancel}>
      <form className="flex flex-col gap-1.5" onSubmit={submit}>
        <label id={`${id}-t`} htmlFor={`${id}-i`} className="font-medium">
          {`Rename ${entry.name}`}
        </label>
        <input
          ref={input}
          id={`${id}-i`}
          value={name}
          maxLength={255}
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
        <div className="flex justify-end gap-2">
          <button type="button" className={BUTTON} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className={BUTTON} disabled={busy}>
            Rename
          </button>
        </div>
      </form>
    </Inline>
  );
}

const TOP = "";

/**
 * "Move to…" (KOBE-304, ac-7): the keyboard way to move, beside drag and drop. The choices are
 * the top level and every folder the tree has listed that may take the entry (open a folder in the
 * tree to list its subfolders); radios, so arrows choose and Enter moves.
 */
export function MoveForm({
  entry,
  folders,
  busy,
  onMove,
  onCancel,
}: {
  readonly entry: FileEntry;
  readonly folders: readonly FileEntry[];
  readonly busy: boolean;
  onMove(folder: string): void;
  onCancel(): void;
}) {
  const id = useId();
  const [filter, setFilter] = useState("");
  const choices = useMemo(() => {
    const paths = [TOP, ...new Set(folders.map((f) => f.path))]
      .filter((p) => canMoveInto(entry.path, entry.type, p))
      .sort((a, b) => a.localeCompare(b));
    const q = filter.trim().toLowerCase();
    return q === "" ? paths : paths.filter((p) => p.toLowerCase().includes(q));
  }, [folders, entry, filter]);
  const [choice, setChoice] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const chosen = choice !== null && choices.includes(choice) ? choice : null;
  return (
    <Inline role="dialog" labelId={`${id}-t`} onCancel={onCancel}>
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (chosen !== null) onMove(chosen);
        }}
      >
        <p id={`${id}-t`} className="m-0 font-medium">
          {`Move ${entry.name} to`}
        </p>
        <input
          ref={first}
          type="search"
          value={filter}
          aria-label="Filter folders"
          placeholder="Filter folders"
          className="border-input bg-background rounded-md border px-1.5 py-0.5 text-sm"
          onChange={(e) => setFilter(e.currentTarget.value)}
        />
        {choices.length === 0 ? (
          <p className="text-muted-foreground m-0">
            No folder here can take it. Open a folder in the tree to list the ones inside it.
          </p>
        ) : (
          <fieldset className="m-0 flex max-h-40 flex-col gap-0.5 overflow-auto border-0 p-0">
            <legend className="sr-only">{`Folder for ${entry.name}`}</legend>
            {choices.map((path) => (
              <label key={path} className="flex items-center gap-1.5 truncate" title={path}>
                <input
                  type="radio"
                  name={`${id}-folder`}
                  value={path}
                  checked={chosen === path}
                  onChange={() => setChoice(path)}
                />
                {path === TOP ? "Workspace (top level)" : path}
              </label>
            ))}
          </fieldset>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={BUTTON} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className={BUTTON} disabled={busy || chosen === null}>
            Move here
          </button>
        </div>
      </form>
    </Inline>
  );
}
