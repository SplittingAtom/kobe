"use client";

import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import type { FileEntry, FilesApi } from "../../lib/files/api";
import type { FileLinksApi, ThreadFileLinks } from "../../lib/threads/file-links";
import { elsewhereText, filesOf, threadsUsing, usedInLabel } from "../../lib/threads/file-map";
import type { Side } from "../../lib/threads/line-model";
import type { MenuBinding } from "../../lib/shell/menu";
import { FileMapOverlay, type ActiveSource } from "./file-map-overlay";
import { FileMapRail, railFilePaths, useRailTree } from "./file-map-rail";
import type { ThreadFileMapValue } from "./thread-file-row";
import { useFileThreads } from "./use-file-links";

interface Pointed {
  readonly side: Side;
  readonly key: string;
}

const same = (a: Pointed | null, b: Pointed | null) =>
  a === b || (a !== null && b !== null && a.side === b.side && a.key === b.key);

/** "thread:<id>" / "file:<path>": a pinned row's key. */
export const pinKey = (side: Side, key: string) => `${side}:${key}`;

function parsePin(pin: string): Pointed {
  const i = pin.indexOf(":");
  return { side: pin.slice(0, i) as Side, key: pin.slice(i + 1) };
}

/**
 * The row under the pointer and the row holding the keyboard focus, in the thread column or the
 * workspace rail (KOBE-612, TFM5): read from the panel's body by delegation, so the rows need
 * no handlers of their own.
 */
function usePointedRows(
  bodyRef: RefObject<HTMLElement | null>,
  threadsRef: RefObject<HTMLElement | null>,
  railRef: RefObject<HTMLElement | null>,
): Pointed | null {
  const [hover, setHover] = useState<Pointed | null>(null);
  const [focus, setFocus] = useState<Pointed | null>(null);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const at = (target: EventTarget | null): Pointed | null => {
      if (!(target instanceof Element)) return null;
      const thread = target.closest("[data-kobe-thread]");
      const id = thread?.getAttribute("data-kobe-thread");
      if (thread && id && threadsRef.current?.contains(thread)) return { side: "thread", key: id };
      const file = target.closest('[role="treeitem"][data-path]');
      const path = file?.getAttribute("data-path");
      if (file && path && railRef.current?.contains(file)) return { side: "file", key: path };
      return null;
    };
    const over = (e: Event) => {
      const next = at(e.target);
      setHover((prev) => (same(prev, next) ? prev : next));
    };
    const leave = () => setHover(null);
    const focusIn = (e: Event) => {
      const next = at(e.target);
      setFocus((prev) => (same(prev, next) ? prev : next));
    };
    const focusOut = (e: FocusEvent) => {
      if (!(e.relatedTarget instanceof Node) || !body.contains(e.relatedTarget)) setFocus(null);
    };
    body.addEventListener("pointerover", over);
    body.addEventListener("pointerleave", leave);
    body.addEventListener("focusin", focusIn);
    body.addEventListener("focusout", focusOut);
    return () => {
      body.removeEventListener("pointerover", over);
      body.removeEventListener("pointerleave", leave);
      body.removeEventListener("focusin", focusIn);
      body.removeEventListener("focusout", focusOut);
    };
  }, [bodyRef, threadsRef, railRef]);
  return hover ?? focus;
}

/**
 * The Threads panel's third rail and its lines (KOBE-612, spec thread-file-map §5), mounted only
 * at three rails: the workspace tree, the batched read of its files' threads, the hovered,
 * focused and pinned rows' lines, and the note naming where off-list threads are.
 */
export function FileMapLayer({
  filesApi,
  linksApi,
  workspaceName,
  links,
  shownThreads,
  pins,
  map,
  bodyRef,
  threadsRef,
  railRef,
  titleOf,
  placeOf,
  openThread,
}: {
  readonly filesApi: FilesApi;
  readonly linksApi: FileLinksApi;
  readonly workspaceName: string;
  readonly links: ReadonlyMap<string, ThreadFileLinks>;
  /** The thread ids with a row in the thread column. */
  readonly shownThreads: ReadonlySet<string>;
  readonly pins: ReadonlySet<string>;
  readonly map: ThreadFileMapValue;
  readonly bodyRef: RefObject<HTMLElement | null>;
  readonly threadsRef: RefObject<HTMLElement | null>;
  readonly railRef: RefObject<HTMLElement | null>;
  titleOf(threadId: string): string;
  /** Where a thread without a row is ("Archived", a folder's name), or null. */
  placeOf(threadId: string): string | null;
  openThread(threadId: string): void;
}) {
  const tree = useRailTree(filesApi);
  const paths = useMemo(() => railFilePaths(tree), [tree]);
  const fileThreads = useFileThreads(linksApi, paths);
  const dirs = useMemo(
    () =>
      new Set(
        tree.rows.flatMap((r) =>
          r.kind === "entry" && r.entry.type === "dir" ? [r.entry.path] : [],
        ),
      ),
    [tree.rows],
  );
  const usesOf = useCallback(
    (path: string) => threadsUsing(path, dirs.has(path), links, fileThreads),
    [dirs, links, fileThreads],
  );
  const pointed = usePointedRows(bodyRef, threadsRef, railRef);

  const sources = useMemo<ActiveSource[]>(() => {
    const rows = [...(pointed ? [pointed] : []), ...[...pins].map(parsePin)];
    return rows.map((r) => ({
      ...r,
      targets:
        r.side === "thread"
          ? filesOf(links.get(r.key))
          : usesOf(r.key).map((t) => ({ key: t.threadId, access: t.access })),
    }));
  }, [pointed, pins, links, usesOf]);

  // A file pointed at: its threads that have no row here, by where they are (spec §5).
  const elsewhere =
    pointed?.side === "file"
      ? elsewhereText(
          usesOf(pointed.key)
            .map((t) => t.threadId)
            .filter((id) => !shownThreads.has(id)),
          placeOf,
        )
      : "";

  const hasLinks = useCallback((entry: FileEntry) => usesOf(entry.path).length > 0, [usesOf]);
  const usedIn = useCallback(
    (entry: FileEntry): MenuBinding | undefined => {
      const uses = usesOf(entry.path);
      const more = entry.type === "file" ? (fileThreads.get(entry.path)?.more ?? 0) : 0;
      const count = uses.length + more;
      if (count === 0) return undefined;
      if (uses.length === 0) {
        return { label: usedInLabel(count), blocker: "Only in threads you can't open." };
      }
      return {
        label: usedInLabel(count),
        choices: uses.map((t) => ({
          key: t.threadId,
          label: t.title || titleOf(t.threadId),
          onSelect: () => openThread(t.threadId),
        })),
      };
    },
    [usesOf, fileThreads, titleOf, openThread],
  );

  return (
    <>
      <div aria-hidden className="bg-border w-px self-stretch" />
      <div className="flex min-w-0 flex-col gap-1">
        <FileMapRail
          tree={tree}
          workspaceName={workspaceName}
          map={map}
          hasLinks={hasLinks}
          usedIn={usedIn}
          railRef={railRef}
        />
        <p
          role="status"
          className="text-muted-foreground m-0 min-h-4 text-xs"
          data-kobe-elsewhere=""
        >
          {elsewhere === "" ? "" : `Also used in threads not shown: ${elsewhere}`}
        </p>
      </div>
      <FileMapOverlay
        containerRef={bodyRef}
        threadsRef={threadsRef}
        filesRef={railRef}
        sources={sources}
      />
    </>
  );
}
