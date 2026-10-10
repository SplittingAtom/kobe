"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRightIcon, DownloadIcon, FileIcon, FolderIcon, Trash2Icon } from "lucide-react";
import type { ApiError } from "../../lib/api/client";
import type { FileEntry, FilesApi } from "../../lib/files/api";
import { saveBytes } from "../../lib/files/save";
import { describeFileError, formatBytes, isReadOnlyPath } from "../../lib/files/format";
import { ErrorNotice } from "../admin/error-notice";
import { useFolder } from "./use-folder";

/** The sandbox syncs shortly after it starts; read the listing again after this. */
const DEFAULT_REFRESH_AFTER_WAKE_MS = 4000;

const iconButton =
  "hover:bg-muted focus-visible:ring-ring/50 inline-flex size-7 items-center justify-center rounded-md border";

/** Opens the panel's wake and tracks "last synced" until the refresh after it. */
function useWake(api: FilesApi, reload: () => void, refreshMs: number): boolean {
  const [waking, setWaking] = useState(true);
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void api.wake().then((res) => {
      if (!current) return;
      if (!res.ok) return setWaking(false);
      timer = setTimeout(() => {
        reload();
        setWaking(false);
      }, refreshMs);
    });
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // reload is stable; the wake runs once per panel opening.
  }, [api, refreshMs]);
  return waking;
}

function Breadcrumb({ path, onOpen }: { readonly path: string; onOpen(path: string): void }) {
  const parts = path === "" ? [] : path.split("/");
  return (
    <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-xs">
      <button type="button" className="underline" onClick={() => onOpen("")}>
        Workspace
      </button>
      {parts.map((part, i) => {
        const target = parts.slice(0, i + 1).join("/");
        const last = i === parts.length - 1;
        return (
          <span key={target} className="flex items-center gap-1">
            <ChevronRightIcon aria-hidden className="size-3" />
            {last ? (
              <span aria-current="page">{part}</span>
            ) : (
              <button type="button" className="underline" onClick={() => onOpen(target)}>
                {part}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function ReadOnlyBadge() {
  return (
    <span className="text-muted-foreground rounded-full border px-1.5 text-[0.65rem]">
      Read-only
    </span>
  );
}

function ConfirmDelete({
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
      className="border-destructive/40 mt-2 flex flex-wrap items-center gap-2 rounded-md border p-2 text-xs"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <p id="kobe-files-confirm" className="min-w-0 flex-1">
        {entry.type === "dir"
          ? `Delete the folder ${entry.name} and everything in it? This cannot be undone.`
          : `Delete ${entry.name}? This cannot be undone.`}
      </p>
      <button
        type="button"
        ref={cancel}
        className="rounded-md border px-2 py-0.5"
        onClick={onCancel}
      >
        Cancel
      </button>
      <button
        type="button"
        className="text-destructive border-destructive/40 rounded-md border px-2 py-0.5"
        disabled={busy}
        onClick={onConfirm}
      >
        Delete
      </button>
    </div>
  );
}

function Row({
  entry,
  onOpen,
  onDownload,
  onDelete,
}: {
  readonly entry: FileEntry;
  onOpen(path: string): void;
  onDownload(entry: FileEntry): void;
  onDelete(entry: FileEntry): void;
}) {
  const readOnly = isReadOnlyPath(entry.path);
  const dir = entry.type === "dir";
  return (
    <li data-file={entry.name} className="flex items-center gap-2 py-1">
      {dir ? (
        <FolderIcon aria-hidden className="size-4 shrink-0" />
      ) : (
        <FileIcon aria-hidden className="size-4 shrink-0" />
      )}
      {dir ? (
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-start underline"
          aria-label={`Open folder ${entry.name}`}
          onClick={() => onOpen(entry.path)}
        >
          {entry.name}
        </button>
      ) : (
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      )}
      {readOnly && entry.path.split("/").length === 1 && <ReadOnlyBadge />}
      {entry.sizeBytes !== null && (
        <span className="text-muted-foreground text-xs">{formatBytes(entry.sizeBytes)}</span>
      )}
      {!dir && (
        <button
          type="button"
          className={iconButton}
          aria-label={`Download ${entry.name}`}
          onClick={() => onDownload(entry)}
        >
          <DownloadIcon aria-hidden className="size-4" />
        </button>
      )}
      {!readOnly && (
        <button
          type="button"
          className={iconButton}
          aria-label={`Delete ${entry.name}`}
          onClick={() => onDelete(entry)}
        >
          <Trash2Icon aria-hidden className="size-4" />
        </button>
      )}
    </li>
  );
}

export function FileBrowser({
  api,
  refreshAfterWakeMs = DEFAULT_REFRESH_AFTER_WAKE_MS,
}: {
  readonly api: FilesApi;
  readonly refreshAfterWakeMs?: number;
}) {
  const [path, setPath] = useState("");
  const folder = useFolder(api, path);
  const waking = useWake(api, folder.reload, refreshAfterWakeMs);
  const [pending, setPending] = useState<FileEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState("");
  const readOnly = isReadOnlyPath(path);

  const open = useCallback((next: string) => {
    setPath(next);
    setPending(null);
    setActionError(null);
    setNotice("");
  }, []);

  const download = async (entry: FileEntry) => {
    setActionError(null);
    const res = await api.download(entry.path);
    if (!res.ok) return setActionError(describeFileError(res.error));
    saveBytes(entry.name, res.data);
    setNotice(`Downloaded ${entry.name}`);
  };

  const remove = async (entry: FileEntry) => {
    setBusy(true);
    setActionError(null);
    const res = await api.remove(entry.path);
    setBusy(false);
    setPending(null);
    if (!res.ok) return setActionError(describeFileError(res.error));
    setNotice(`Deleted ${entry.name}`);
    folder.reload();
  };

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setActionError(null);
    const done: string[] = [];
    for (const file of Array.from(files)) {
      const res = await api.upload(path, file);
      if (!res.ok) {
        setActionError(describeFileError(res.error));
        break;
      }
      done.push(file.name);
    }
    setBusy(false);
    if (done.length > 0) {
      setNotice(`Uploaded ${done.join(", ")}`);
      folder.reload();
    }
  };

  const where = path === "" ? "the workspace root" : path;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
      <Breadcrumb path={path} onOpen={open} />
      {waking && (
        <p role="status" className="text-muted-foreground text-xs">
          Showing the last synced files while your sandbox wakes.
        </p>
      )}
      {readOnly ? (
        <p className="text-muted-foreground text-xs">
          This folder is read-only: files here cannot be uploaded or deleted.
        </p>
      ) : (
        <label className="text-xs">
          <span className="sr-only">{`Upload a file to ${where}`}</span>
          <input
            type="file"
            multiple
            disabled={busy}
            aria-label={`Upload a file to ${where}`}
            onChange={(e) => {
              void upload(e.currentTarget.files);
              e.currentTarget.value = "";
            }}
          />
        </label>
      )}
      {folder.error && <ErrorNotice error={describeFileError(folder.error)} />}
      {actionError && <ErrorNotice error={actionError} />}
      {folder.loading && folder.entries.length === 0 && !folder.error && (
        <p role="status">Loading files…</p>
      )}
      {!folder.loading && !folder.error && folder.entries.length === 0 && (
        <p className="text-muted-foreground text-xs">This folder is empty.</p>
      )}
      <ul aria-label={`Files in ${where}`} className="divide-y text-sm">
        {folder.entries.map((entry) => (
          <Row
            key={entry.path}
            entry={entry}
            onOpen={open}
            onDownload={(e) => void download(e)}
            onDelete={setPending}
          />
        ))}
      </ul>
      {folder.nextCursor !== null && (
        <button
          type="button"
          className="self-start rounded-md border px-2 py-0.5 text-xs"
          onClick={folder.loadMore}
        >
          Load more
        </button>
      )}
      {pending && (
        <ConfirmDelete
          entry={pending}
          busy={busy}
          onConfirm={() => void remove(pending)}
          onCancel={() => setPending(null)}
        />
      )}
      <p role="status" className="sr-only">
        {notice}
      </p>
    </div>
  );
}
