"use client";

import { useState, type FormEvent } from "react";
import type { ApiResult } from "../../lib/api/client";
import { foldersOf } from "../../lib/chat/folders-store";
import {
  canNestIn,
  CURRENT,
  deleteQuestion,
  moveTargets,
  nodeKey,
  type PlacedFolder,
} from "../../lib/chat/folder-tree";
import type { MenuBindings, MenuChoice } from "../../lib/shell/menu";
import { useChatSession } from "../chat/kobe-runtime";
import chat from "../chat/chat.module.css";

export const TOO_DEEP = "Folders go three levels deep";

/** What the inline editor below the tree is doing. */
export type FolderEditing =
  | { readonly kind: "new"; readonly parent: PlacedFolder | null }
  | { readonly kind: "rename"; readonly placed: PlacedFolder }
  | { readonly kind: "delete"; readonly placed: PlacedFolder }
  | { readonly kind: "error"; readonly message: string };

export interface FolderActions {
  readonly editing: FolderEditing | null;
  /** The ⋯ menu of one folder node (TF7): Rename, New folder inside, Move to…, Delete. */
  bindings(placed: PlacedFolder): MenuBindings;
  startNew(parent: PlacedFolder | null): void;
  close(): void;
}

/** Focuses a node's row in the tree (or the phone dropdown) once it is on screen again. */
function focusNode(key: string) {
  requestAnimationFrame(() => {
    const row = document.querySelector<HTMLElement>(`[data-kobe-node="${CSS.escape(key)}"]`);
    (row ?? document.querySelector<HTMLElement>("[data-kobe-folder-picker]"))?.focus();
  });
}

/**
 * The folder nodes' actions (KOBE-536, TF7), shared by the tree and the phone dropdown. Every
 * change goes to the server, which rules names, depth and cycles; its refusal shows inline.
 * After a change the tree reads the folders again (the store), so counts and names follow.
 */
export function useFolderActions(
  placed: readonly PlacedFolder[],
  announce: (text: string) => void,
): FolderActions {
  const session = useChatSession();
  const [editing, setEditing] = useState<FolderEditing | null>(null);

  const move = (p: PlacedFolder, parentId: string | null, where: string) => {
    void session.folders.update(p.folder.id, { parentId }).then((res) => {
      if (!res.ok) return setEditing({ kind: "error", message: res.error.message });
      setEditing(null);
      if (parentId !== null) session.panelMemory.setFolderOpen(parentId, true);
      announce(`Moved “${p.folder.name}” to ${where}.`);
      focusNode(nodeKey({ kind: "folder", id: p.folder.id }));
    });
  };

  const bindings = (p: PlacedFolder): MenuBindings => {
    const targets: MenuChoice[] = [
      ...(p.folder.parentId === null
        ? []
        : [{ key: "", label: "Top level", onSelect: () => move(p, null, "the top level") }]),
      ...moveTargets(placed, p).map((t) => ({
        key: t.folder.id,
        label: t.folder.name,
        depth: t.depth - 1,
        onSelect: () => move(p, t.folder.id, t.folder.name),
      })),
    ];
    return {
      "rename-folder": {
        onSelect: () => setEditing({ kind: "rename", placed: p }),
        movesFocus: true,
      },
      "new-subfolder": {
        onSelect: () => setEditing({ kind: "new", parent: p }),
        blocker: canNestIn(p) ? null : TOO_DEEP,
        movesFocus: true,
      },
      "move-folder": {
        choices: targets,
        blocker: targets.length === 0 ? "There is nowhere else to move it." : null,
      },
      "delete-folder": {
        onSelect: () => setEditing({ kind: "delete", placed: p }),
        destructive: true,
        movesFocus: true,
      },
    };
  };

  return {
    editing,
    bindings,
    startNew: (parent) => setEditing({ kind: "new", parent }),
    close: () => setEditing(null),
  };
}

function NameForm({
  label,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  readonly label: string;
  readonly initial: string;
  readonly submitLabel: string;
  onSubmit(name: string): Promise<ApiResult<unknown>>;
  onCancel(): void;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    void onSubmit(name).then((res) => {
      setSaving(false);
      if (!res.ok) setError(res.error.message);
    });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5" data-kobe-folder-editor="">
      <input
        aria-label={label}
        aria-invalid={error !== null || undefined}
        // An inline field the member opened on purpose: it takes the focus.
        autoFocus
        maxLength={80}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        className="h-7 min-w-0 rounded-md border bg-background px-2 text-sm"
      />
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      <span className="flex gap-2">
        <button type="submit" className="text-xs font-medium underline" disabled={saving}>
          {submitLabel}
        </button>
        <button type="button" className="text-xs underline" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </form>
  );
}

/**
 * The inline editor below the tree (or the phone dropdown): a new folder's name, a rename, the
 * Delete confirmation, or a refused change. Names are text, never HTML.
 */
export function FolderEditor({
  actions,
  announce,
}: {
  readonly actions: FolderActions;
  announce(text: string): void;
}) {
  const session = useChatSession();
  const { editing, close } = actions;
  if (editing === null) return null;
  const done = (key: string) => {
    close();
    focusNode(key);
  };
  if (editing.kind === "error") {
    return (
      <div className="flex flex-col gap-1">
        <p role="alert" className="text-destructive text-xs">
          {editing.message}
        </p>
        <button type="button" className="self-start text-xs underline" onClick={close}>
          Dismiss
        </button>
      </div>
    );
  }
  if (editing.kind === "new") {
    const parent = editing.parent;
    return (
      <NameForm
        key={`new:${parent?.folder.id ?? ""}`}
        label={parent ? `New folder in ${parent.folder.name}` : "New folder name"}
        initial=""
        submitLabel="Create"
        onCancel={() =>
          done(parent ? nodeKey({ kind: "folder", id: parent.folder.id }) : "current")
        }
        onSubmit={async (name) => {
          const res = await session.folders.create(name, parent?.folder.id ?? null);
          if (res.ok) {
            if (parent) session.panelMemory.setFolderOpen(parent.folder.id, true);
            announce(`Created the folder “${res.data.name}”.`);
            done(nodeKey({ kind: "folder", id: res.data.id }));
          }
          return res;
        }}
      />
    );
  }
  const { folder } = editing.placed;
  const key = nodeKey({ kind: "folder", id: folder.id });
  if (editing.kind === "rename") {
    return (
      <NameForm
        key={`rename:${folder.id}`}
        label={`Rename ${folder.name}`}
        initial={folder.name}
        submitLabel="Rename"
        onCancel={() => done(key)}
        onSubmit={async (name) => {
          if (name.trim() === folder.name) {
            done(key);
            return { ok: true, status: 200, data: null };
          }
          const res = await session.folders.update(folder.id, { name });
          if (res.ok) {
            announce(`Renamed “${folder.name}” to “${res.data.name}”.`);
            done(key);
          }
          return res;
        }}
      />
    );
  }
  return (
    <DeleteConfirm
      question={deleteQuestion(editing.placed)}
      onCancel={() => done(key)}
      onDelete={async () => {
        const res = await session.folders.remove(folder.id);
        if (res.ok) {
          // The chosen folder (or one inside it) is gone: the panel shows Current.
          const memory = session.panelMemory;
          const chosen = memory.folderId;
          const left = foldersOf(session.folders.getState());
          if (chosen !== null && !left.some((f) => f.id === chosen)) memory.choose(CURRENT);
          announce(`Deleted the folder “${folder.name}”.`);
          done("current");
        }
        return res;
      }}
    />
  );
}

function DeleteConfirm({
  question,
  onDelete,
  onCancel,
}: {
  readonly question: string;
  onDelete(): Promise<ApiResult<unknown>>;
  onCancel(): void;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div role="group" aria-label="Delete folder" className="flex flex-col gap-1.5">
      <p className={chat.hint}>{question}</p>
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      <span className="flex gap-2">
        <button
          type="button"
          autoFocus
          className="text-destructive text-xs font-medium underline"
          onClick={() =>
            void onDelete().then((res) => {
              if (!res.ok) setError(res.error.message);
            })
          }
        >
          Delete
        </button>
        <button type="button" className="text-xs underline" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </div>
  );
}
