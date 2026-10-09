"use client";

/**
 * The workspace file panel (KOBE-151): a thread side panel beside the artifact panel, opened from
 * the thread header. A labelled region, closable with Escape (focus goes back to the opener).
 * Opening it wakes the sandbox (`POST /v1/workspace/wake`) while the last synced listing is shown.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { FolderIcon, XIcon } from "lucide-react";
import type { FilesApi } from "../../lib/files/api";
import { cn } from "../../lib/utils";
import { FileBrowser } from "./file-browser";

interface FilesPanelApi {
  readonly open: boolean;
  toggle(): void;
  close(): void;
}

const FilesPanelContext = createContext<FilesPanelApi | null>(null);

export function useFilesPanel(): FilesPanelApi | null {
  return useContext(FilesPanelContext);
}

/** `scope` (team) changing closes the panel: the files belong to another workspace. */
export function FilesPanelProvider({
  scope,
  children,
}: {
  readonly scope: string;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [seenScope, setSeenScope] = useState(scope);
  if (seenScope !== scope) {
    setSeenScope(scope);
    setOpen(false);
  }
  const opener = useRef<Element | null>(null);
  const toggle = useCallback(() => {
    opener.current = document.activeElement;
    setOpen((o) => !o);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    const back = opener.current;
    opener.current = null;
    if (back instanceof HTMLElement) back.focus();
  }, []);
  const api = useMemo(() => ({ open, toggle, close }), [open, toggle, close]);
  return <FilesPanelContext.Provider value={api}>{children}</FilesPanelContext.Provider>;
}

export function FilesToggleButton() {
  const panel = useFilesPanel();
  if (!panel) return null;
  return (
    <button
      type="button"
      className="hover:bg-muted inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs"
      aria-expanded={panel.open}
      onClick={panel.toggle}
    >
      <FolderIcon aria-hidden className="size-3.5" />
      Files
    </button>
  );
}

export function FilesPanel({
  api,
  className,
  refreshAfterWakeMs,
}: {
  readonly api: FilesApi;
  readonly className?: string | undefined;
  /** How long after the wake request the listing is read again (the sandbox syncs on start). */
  readonly refreshAfterWakeMs?: number | undefined;
}) {
  const panel = useFilesPanel();
  const ref = useRef<HTMLElement>(null);
  const open = panel?.open ?? false;
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);
  if (!panel || !open) return null;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.stopPropagation();
      panel.close();
    }
  };
  return (
    <aside
      ref={ref}
      tabIndex={-1}
      role="region"
      aria-labelledby="kobe-files-title"
      onKeyDown={onKeyDown}
      className={cn(
        "bg-background flex min-h-96 min-w-0 flex-col border-s outline-none",
        className,
      )}
    >
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <h2 id="kobe-files-title" className="min-w-0 flex-1 truncate text-sm font-medium">
          Workspace files
        </h2>
        <button
          type="button"
          className="hover:bg-muted inline-flex size-7 items-center justify-center rounded-md border"
          aria-label="Close files"
          onClick={panel.close}
        >
          <XIcon aria-hidden className="size-4" />
        </button>
      </header>
      <FileBrowser
        api={api}
        {...(refreshAfterWakeMs === undefined ? {} : { refreshAfterWakeMs })}
      />
    </aside>
  );
}
