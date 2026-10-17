"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FolderIcon, UploadIcon } from "lucide-react";
import { WORKSPACE_DROP_FOLDER } from "@kobe/protocol";
import type { ApiError } from "../../lib/api/client";
import type { FileEntry, FilesApi } from "../../lib/files/api";
import { saveBytes } from "../../lib/files/save";
import { describeFileError, isReadOnlyPath, parentPath } from "../../lib/files/format";
import { folderError, type DroppedItems } from "../../lib/files/drop";
import { baseName, expandedKey, joinPath } from "../../lib/files/tree";
import { ErrorNotice } from "../admin/error-notice";
import { copyText } from "../../lib/clipboard";
import type { MenuBindings } from "../../lib/shell/menu";
import { cn } from "../../lib/utils";
import { ConfirmDelete, MoveForm, RenameForm } from "./file-dialogs";
import { DROP_FOLDER_ATTR, FileTreeView, type Dragging, type TreeFocus } from "./file-tree";
import { useFileTree, type FileTree } from "./use-file-tree";

const COPY_FAILED = {
  status: 0,
  code: "client_error",
  message: "The path could not be copied: the browser refused the clipboard.",
} as const;

/** The sandbox syncs shortly after it starts; read the listing again after this. */
const DEFAULT_REFRESH_AFTER_WAKE_MS = 4000;

/**
 * Wakes the sandbox on mount and again on each new `key` (the member asked for the files again),
 * listing again at once and after the sync; tracks "last synced" until that refresh.
 */
function useWake(api: FilesApi, reload: () => void, refreshMs: number, key: number): boolean {
  const [doneKey, setDoneKey] = useState<number | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (mounted.current) reload(); // the first listing is the tree's own
    mounted.current = true;
    void api.wake().then((res) => {
      if (!current) return;
      if (!res.ok) return setDoneKey(key);
      timer = setTimeout(() => {
        reload();
        setDoneKey(key);
      }, refreshMs);
    });
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // reload is stable; the wake runs once per ask.
  }, [api, refreshMs, key]);
  return doneKey !== key;
}

type Dialog = { readonly kind: "delete" | "rename" | "move"; readonly entry: FileEntry } | null;

const where = (folder: string) => (folder === "" ? "the workspace root" : folder);

/**
 * A row's ⋯ menu (KOBE-292, KOBE-304): Open, Mention in message (files, KOBE-374), Download,
 * Rename, Move to…, Copy path, Delete.
 */
function rowBindings(
  entry: FileEntry,
  handlers: {
    readonly onOpen: (() => void) | undefined;
    readonly onMention: (() => void) | undefined;
    readonly onDownload: () => void;
    readonly onRename: () => void;
    readonly onMove: () => void;
    readonly onCopyPath: () => void;
    readonly onDelete: () => void;
  },
): MenuBindings {
  const readOnly = isReadOnlyPath(entry.path);
  const change = (onSelect: () => void, destructive = false) => ({
    onSelect,
    movesFocus: true,
    ...(destructive ? { destructive } : {}),
  });
  return {
    ...(handlers.onOpen ? { "open-file": { onSelect: handlers.onOpen } } : {}),
    // Focus goes to the composer, so the menu doesn't give it back to its button.
    ...(entry.type === "file" && handlers.onMention
      ? { "mention-file": { onSelect: handlers.onMention, movesFocus: true } }
      : {}),
    ...(entry.type === "file" ? { "download-file": { onSelect: handlers.onDownload } } : {}),
    ...(readOnly
      ? {}
      : { "rename-file": change(handlers.onRename), "move-file": change(handlers.onMove) }),
    "copy-file-path": { onSelect: handlers.onCopyPath },
    ...(readOnly ? {} : { "delete-file": change(handlers.onDelete, true) }),
  };
}

/** The top-level row: the workspace's name, a drop target for the top level, and Upload. */
function RootHeader({
  drag,
  folder,
  busy,
  onUpload,
}: {
  readonly drag: Parameters<Parameters<typeof FileTreeView>[0]["header"]>[0];
  readonly folder: string;
  readonly busy: boolean;
  onUpload(files: FileList | null): void;
}) {
  const label = `Upload a file to ${where(folder)}`;
  return (
    <div
      {...{ [DROP_FOLDER_ATTR]: "" }}
      {...(drag.target === "" ? { "data-drop-target": "" } : {})}
      className={cn(
        "flex h-6.5 items-center gap-1 rounded-sm ps-0.5 text-xs font-medium",
        drag.target === "" && "bg-accent ring-ring ring-1 ring-inset",
      )}
      onDragOver={(e) => drag.handlers.over(e, "", true)}
      onDrop={(e) => drag.handlers.drop(e, "", true)}
    >
      <FolderIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">Workspace</span>
      {!isReadOnlyPath(folder) && (
        <label
          className={cn(
            "hover:bg-muted flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md",
            busy && "pointer-events-none opacity-50",
          )}
          title={label}
        >
          <UploadIcon aria-hidden className="size-3.5" />
          <input
            type="file"
            multiple
            className="sr-only"
            disabled={busy}
            aria-label={label}
            onChange={(e) => {
              onUpload(e.currentTarget.files);
              e.currentTarget.value = "";
            }}
          />
        </label>
      )}
    </div>
  );
}

function FolderNote({ folder }: { readonly folder: string }) {
  if (!isReadOnlyPath(folder)) return null;
  return (
    <p className="text-muted-foreground m-0 text-xs">
      {folder === WORKSPACE_DROP_FOLDER
        ? "Drop files on the rail to add them here. Files your threads attached are read-only."
        : "This folder is read-only: files here cannot be uploaded or deleted."}
    </p>
  );
}

function Status({ tree }: { readonly tree: FileTree }) {
  const { root } = tree;
  if (root.loading && root.entries.length === 0 && !root.error) {
    return (
      <p role="status" className="m-0 text-xs">
        Loading files…
      </p>
    );
  }
  if (!root.loading && !root.error && root.entries.length === 0) {
    return <p className="text-muted-foreground m-0 text-xs">Your workspace is empty.</p>;
  }
  return null;
}

function FolderErrors({ tree }: { readonly tree: FileTree }): ReactNode {
  return (
    <>
      {tree.root.error && <ErrorNotice error={describeFileError(tree.root.error)} />}
      {tree.errors.map(({ folder, load }) =>
        load.error ? (
          <ErrorNotice
            key={folder}
            error={{
              ...describeFileError(load.error),
              message: `${folder}: ${describeFileError(load.error).message}`,
            }}
          />
        ) : null,
      )}
    </>
  );
}

/**
 * The workspace rail's Files (KOBE-148, KOBE-304): a compact tree of the caller's synced
 * workspace with file-type icons. Files open in the artifact column (KOBE-268); each row has the
 * ⋯ menu (KOBE-292); files and folders move by drag and drop or Move to…, and rename with F2 or
 * the menu, through the server's move API, which decides; files dropped from the computer onto a
 * folder upload there (anywhere else on the rail they go to uploads/, KOBE-199).
 */
export function FileBrowser({
  api,
  refreshAfterWakeMs = DEFAULT_REFRESH_AFTER_WAKE_MS,
  wakeKey = 0,
  showFolder = null,
  onOpenFile,
  onMoved,
  onMention,
}: {
  readonly api: FilesApi;
  /**
   * "Mention in message" (KOBE-374): the file goes into the composer as an @file mention; the
   * answer is why it could not, or undefined once it did. Absent: no such item.
   */
  readonly onMention?: ((entry: FileEntry) => string | undefined) | undefined;
  /** A file opens in the artifact column (KOBE-268). */
  readonly onOpenFile?: ((entry: FileEntry) => void) | undefined;
  /** A file or folder moved: open tabs of it follow (KOBE-304, ac-9). */
  readonly onMoved?: ((from: string, to: string) => void) | undefined;
  readonly refreshAfterWakeMs?: number;
  /** A new value wakes the sandbox and lists again (Show files, refresh). */
  readonly wakeKey?: number;
  /** Reveals this folder, once per `seq` (uploads/ after a rail drop, KOBE-199). */
  readonly showFolder?: { readonly path: string; readonly seq: number } | null;
}) {
  const tree = useFileTree(api, expandedKey(api.teamId));
  const waking = useWake(api, tree.reloadAll, refreshAfterWakeMs, wakeKey);
  const [focus, setFocus] = useState<TreeFocus>({ path: null, folder: "" });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState("");
  const [focusRequest, setFocusRequest] = useState<{ path: string; seq: number } | null>(null);
  const shownSeq = useRef(showFolder?.seq ?? 0);
  const { reveal, moved } = tree;

  const focusRow = useCallback(
    (path: string) => setFocusRequest((prev) => ({ path, seq: (prev?.seq ?? 0) + 1 })),
    [],
  );
  const start = () => {
    setActionError(null);
    setNotice("");
  };

  const firstShow = useRef(true);
  useEffect(() => {
    if (!showFolder) return;
    if (showFolder.seq === shownSeq.current && !firstShow.current) return;
    firstShow.current = false;
    shownSeq.current = showFolder.seq;
    reveal(showFolder.path); // a drop landed there: open it and list it again
  }, [showFolder, reveal]);

  const closeDialog = (entry: FileEntry) => {
    setDialog(null);
    focusRow(entry.path);
  };

  const download = async (entry: FileEntry) => {
    start();
    const res = await api.download(entry.path);
    if (!res.ok) return setActionError(describeFileError(res.error));
    saveBytes(entry.name, res.data);
    setNotice(`Downloaded ${entry.name}`);
  };

  const mention = (entry: FileEntry) => {
    start();
    const refused = onMention?.(entry);
    if (refused !== undefined) {
      focusRow(entry.path);
      return setActionError({ status: 0, code: "client_error", message: refused });
    }
    setNotice(`Mentioned ${entry.name} in your message`);
  };

  /** The path inside the workspace (the agent's working directory), as the listing names it. */
  const copyPath = (entry: FileEntry) => {
    copyText(entry.path).then(
      () => setNotice(`Copied the path of ${entry.name}`),
      () => setActionError(COPY_FAILED),
    );
  };

  const remove = async (entry: FileEntry) => {
    setBusy(true);
    start();
    const res = await api.remove(entry.path);
    setBusy(false);
    setDialog(null);
    if (!res.ok) {
      focusRow(entry.path);
      return setActionError(describeFileError(res.error));
    }
    setNotice(`Deleted ${entry.name}`);
    reveal(parentPath(entry.path));
    focusRow(parentPath(entry.path));
  };

  const move = async (from: string, to: string, verb: "Moved" | "Renamed") => {
    setBusy(true);
    start();
    const res = await api.move(from, to);
    setBusy(false);
    setDialog(null);
    if (!res.ok) {
      focusRow(from);
      return setActionError(describeFileError(res.error));
    }
    moved(from, to);
    reveal(parentPath(from));
    if (parentPath(to) !== parentPath(from)) reveal(parentPath(to));
    onMoved?.(from, to);
    setNotice(
      verb === "Renamed"
        ? `Renamed ${baseName(from)} to ${baseName(to)}`
        : `Moved ${baseName(from)} to ${where(parentPath(to))}`,
    );
    focusRow(to);
  };

  const uploadInto = async (folder: string, items: DroppedItems) => {
    setBusy(true);
    start();
    const done: string[] = [];
    if (items.folders.length > 0) setActionError(folderError(items.folders));
    for (const file of items.files) {
      const res = await api.upload(folder, file);
      if (!res.ok) {
        const described = describeFileError(res.error);
        setActionError({ ...described, message: `${file.name}: ${described.message}` });
        if (res.error.code === "quota_exceeded") break;
        continue;
      }
      done.push(res.data.name);
    }
    setBusy(false);
    if (done.length > 0) {
      setNotice(`Uploaded ${done.join(", ")}`);
      reveal(folder);
    }
  };

  const actions = {
    onOpenFile,
    bindings: (entry: FileEntry) =>
      rowBindings(entry, {
        onOpen:
          entry.type === "dir"
            ? () => {
                tree.expand(entry.path);
                focusRow(entry.path);
              }
            : onOpenFile && (() => onOpenFile(entry)),
        onMention: onMention && (() => mention(entry)),
        onDownload: () => void download(entry),
        onRename: () => setDialog({ kind: "rename", entry }),
        onMove: () => setDialog({ kind: "move", entry }),
        onCopyPath: () => copyPath(entry),
        onDelete: () => setDialog({ kind: "delete", entry }),
      }),
    onRename: (entry: FileEntry) => setDialog({ kind: "rename", entry }),
    onDelete: (entry: FileEntry) => setDialog({ kind: "delete", entry }),
    onMove: (dragging: Dragging, folder: string) =>
      void move(dragging.path, joinPath(folder, baseName(dragging.path)), "Moved"),
    onUpload: (folder: string, items: DroppedItems) => void uploadInto(folder, items),
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto px-2 py-1.5">
      {waking && (
        <p role="status" className="text-muted-foreground m-0 text-xs">
          Showing the last synced files while your sandbox wakes.
        </p>
      )}
      <FolderErrors tree={tree} />
      {actionError && <ErrorNotice error={actionError} />}
      <FileTreeView
        tree={tree}
        label="Files in your workspace"
        actions={actions}
        focusRequest={focusRequest}
        onFocusChange={setFocus}
        header={(drag) => (
          <RootHeader
            drag={drag}
            folder={focus.folder}
            busy={busy}
            onUpload={(files) =>
              void uploadInto(focus.folder, { files: Array.from(files ?? []), folders: [] })
            }
          />
        )}
      />
      <Status tree={tree} />
      <FolderNote folder={focus.folder} />
      {dialog?.kind === "delete" && (
        <ConfirmDelete
          entry={dialog.entry}
          busy={busy}
          onConfirm={() => void remove(dialog.entry)}
          onCancel={() => closeDialog(dialog.entry)}
        />
      )}
      {dialog?.kind === "rename" && (
        <RenameForm
          entry={dialog.entry}
          busy={busy}
          onRename={(name) =>
            void move(dialog.entry.path, joinPath(parentPath(dialog.entry.path), name), "Renamed")
          }
          onCancel={() => closeDialog(dialog.entry)}
        />
      )}
      {dialog?.kind === "move" && (
        <MoveForm
          entry={dialog.entry}
          folders={tree.knownFolders}
          busy={busy}
          onMove={(folder) =>
            void move(dialog.entry.path, joinPath(folder, baseName(dialog.entry.path)), "Moved")
          }
          onCancel={() => closeDialog(dialog.entry)}
        />
      )}
      <p role="status" className="sr-only">
        {notice}
      </p>
    </div>
  );
}
