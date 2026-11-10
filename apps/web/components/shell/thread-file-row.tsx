"use client";

import { ChevronRightIcon, PinIcon } from "lucide-react";
import { createContext, useContext, useId, useState } from "react";
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

/** The pin toggle of a row (a thread or a file): keeps its lines shown (TFM5). */
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
        "text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex size-5 shrink-0 items-center justify-center rounded-sm outline-none focus-visible:ring-2",
        pinned ? "text-primary" : "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100",
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
}: {
  readonly id: string;
  readonly title: string;
  readonly links: ThreadFileLinks;
  openFile(path: string): void;
}) {
  return (
    <ul id={id} aria-label={`Files ${title} used`} className="m-0 ms-6 list-none ps-0 text-xs">
      {links.files.map((f) => (
        <li key={`${f.path}:${f.access}`} className="flex min-w-0 items-center gap-1">
          {f.deleted ? (
            <span className="text-muted-foreground truncate" title={f.path}>
              {baseName(f.path)} (deleted)
            </span>
          ) : (
            <button
              type="button"
              className="min-w-0 truncate text-start underline"
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

/**
 * Under a thread row with links: "Files (N)", opening the list of its files as links (open the
 * file; deleted ones named, the viewer's unseen ones counted, TFM7), and at three rails the pin.
 * The keyboard and screen-reader way to the same links the lines draw.
 */
export function ThreadFilesRow({
  threadId,
  title,
}: {
  readonly threadId: string | undefined;
  readonly title: string;
}) {
  const map = useContext(ThreadFileMap);
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (map === null || threadId === undefined) return null;
  const links = map.linksOf(threadId);
  const count = fileCount(links);
  if (links === undefined || count === 0) return null;
  return (
    <div data-kobe-thread-files="" className="group/row">
      <div className="ms-6 flex items-center gap-1 text-xs">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3 motion-safe:transition-transform", open && "rotate-90")}
          />
          Files ({count})
        </button>
        {map.lines && <LinePin side="thread" pathOrId={threadId} name={title} map={map} />}
      </div>
      {open && <FilesList id={listId} title={title} links={links} openFile={map.openFile} />}
    </div>
  );
}
