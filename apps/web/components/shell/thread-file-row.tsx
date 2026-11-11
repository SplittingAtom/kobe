"use client";

import { PinIcon } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { MenuBinding } from "../../lib/shell/menu";
import type { ThreadFileLinks } from "../../lib/threads/file-links";
import { accessWord, baseName, fileCount, hiddenFilesText } from "../../lib/threads/file-map";
import type { Side } from "../../lib/threads/line-model";
import { cn } from "../../lib/utils";

/**
 * What a thread row of the Threads panel adds about its files (KOBE-612, spec thread-file-map
 * §5, TFM4/TFM5), from the panel. Null elsewhere (the rail's rows add nothing).
 */
export interface ThreadFileMapValue {
  /** Three rails: rows get a pin that keeps their lines shown. */
  readonly lines: boolean;
  linksOf(threadId: string): ThreadFileLinks | undefined;
  isPinned(side: Side, key: string): boolean;
  togglePin(side: Side, key: string): void;
  /** Opens a workspace file in the artifact column. */
  openFile(path: string): void;
}

export const ThreadFileMap = createContext<ThreadFileMapValue | null>(null);

/**
 * The pin toggle of a row (a thread or a file): keeps its lines shown (TFM5). Pinned, it always
 * shows; otherwise it shows while the row (`group/row`) is hovered or holds the focus, and always
 * on touch screens, which have no hover (KOBE-614).
 */
export function LinePin({
  side,
  pathOrId,
  name,
  map,
}: {
  readonly side: Side;
  readonly pathOrId: string;
  readonly name: string;
  readonly map: Pick<ThreadFileMapValue, "isPinned" | "togglePin">;
}) {
  const pinned = map.isPinned(side, pathOrId);
  return (
    <button
      type="button"
      aria-pressed={pinned}
      aria-label={`Keep lines shown for ${name}`}
      title={pinned ? "Lines kept shown" : "Keep lines shown"}
      data-kobe-line-pin={pinned ? "on" : "off"}
      className={cn(
        "text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex size-5 shrink-0 items-center justify-center rounded-sm border-0 bg-transparent p-0 outline-none focus-visible:ring-2",
        pinned
          ? "text-primary"
          : "pointer-fine:opacity-0 pointer-fine:group-hover/row:opacity-100 pointer-fine:group-focus-within/row:opacity-100 focus-visible:opacity-100",
      )}
      onClick={(e) => {
        e.stopPropagation();
        map.togglePin(side, pathOrId);
      }}
    >
      <PinIcon aria-hidden className="size-3.5" />
    </button>
  );
}

function FilesList({
  id,
  title,
  links,
  openFile,
  onClose,
}: {
  readonly id: string;
  readonly title: string;
  readonly links: ThreadFileLinks;
  openFile(path: string): void;
  onClose(): void;
}) {
  const ref = useRef<HTMLUListElement>(null);
  // Opened from the row's menu: the focus moves to the first file (KOBE-614).
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);
  return (
    <ul
      ref={ref}
      id={id}
      aria-label={`Files ${title} used`}
      data-kobe-thread-files=""
      className="m-0 ms-6 list-none ps-0 text-xs"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        // Back to the row's ⋯ menu button, where the list was opened from.
        const row = ref.current?.closest("[data-kobe-thread]");
        row?.querySelector<HTMLElement>('[aria-label^="Actions for "]')?.focus();
        onClose();
      }}
    >
      {links.files.map((f) => (
        <li key={`${f.path}:${f.access}`} className="flex min-w-0 items-center gap-1">
          {f.deleted ? (
            <span className="text-muted-foreground truncate" title={f.path}>
              {baseName(f.path)} (deleted)
            </span>
          ) : (
            <button
              type="button"
              className="min-w-0 truncate border-0 bg-transparent p-0 text-start underline"
              title={f.path}
              onClick={() => openFile(f.path)}
            >
              {baseName(f.path)}
            </button>
          )}
          <span className="text-muted-foreground shrink-0">{accessWord(f)}</span>
        </li>
      ))}
      {links.hiddenCount > 0 && (
        <li className="text-muted-foreground">{hiddenFilesText(links.hiddenCount)}</li>
      )}
    </ul>
  );
}

/** What a thread row of the Threads panel shows about its files (KOBE-612, KOBE-614). */
export interface ThreadFiles {
  /** The line pin, after the title (three rails only); null without links. */
  readonly pin: ReactNode;
  /** The row menu's "Files (N)…" item; undefined without links. */
  readonly binding: MenuBinding | undefined;
  /** The list of the thread's files under the row, while open. */
  readonly list: ReactNode;
}

const NONE: ThreadFiles = { pin: null, binding: undefined, list: null };

/**
 * A thread row's files in the Threads panel (KOBE-614): the line pin on the row, "Files (N)…" in
 * its ⋯ menu, opening the list of its files as links (open the file; deleted ones named, the
 * viewer's unseen ones counted, TFM7) under the row; the menu item again or Escape closes it.
 * The keyboard and screen-reader way to the same links the lines draw. Nothing elsewhere.
 */
export function useThreadFiles(threadId: string | undefined, title: string): ThreadFiles {
  const map = useContext(ThreadFileMap);
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (map === null || threadId === undefined) return NONE;
  const links = map.linksOf(threadId);
  const count = fileCount(links);
  if (links === undefined || count === 0) return NONE;
  return {
    pin: map.lines ? <LinePin side="thread" pathOrId={threadId} name={title} map={map} /> : null,
    binding: {
      label: open ? `Hide files (${count})` : `Files (${count})…`,
      movesFocus: !open,
      onSelect: () => setOpen((v) => !v),
    },
    list: open ? (
      <FilesList
        id={listId}
        title={title}
        links={links}
        openFile={map.openFile}
        onClose={() => setOpen(false)}
      />
    ) : null,
  };
}
