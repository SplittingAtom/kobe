"use client";

import { useMemo, type RefObject } from "react";
import type { FileEntry, FilesApi } from "../../lib/files/api";
import { expandedKey } from "../../lib/files/tree";
import type { MenuBinding, MenuBindings } from "../../lib/shell/menu";
import { FileTreeView, type TreeActions } from "../files/file-tree";
import { useFileTree, type FileTree } from "../files/use-file-tree";
import { LayersIcon } from "lucide-react";
import { IconAction } from "./icon-action";
import { LinePin, type ThreadFileMapValue } from "./thread-file-row";

const nothing = () => undefined;

/** The rail's own expanded folders, apart from the Files panel's. */
const railKey = (teamId: string) => `${expandedKey(teamId)}:threads-panel`;

/** The Threads panel's workspace tree: read once per panel, its rows' paths for the batch reads. */
export function useRailTree(api: FilesApi): FileTree {
  return useFileTree(api, railKey(api.teamId));
}

/** The paths on screen in the rail (files and folders), for the batched `file-threads` read. */
export function railFilePaths(tree: FileTree): string[] {
  return tree.rows.flatMap((r) =>
    r.kind === "entry" && r.entry.type === "file" ? [r.entry.path] : [],
  );
}

/**
 * The third rail of the Threads panel (KOBE-612, spec thread-file-map §5): the Files panel's
 * workspace tree, read-only here (open a file, fold folders; no rename, delete, upload or drag,
 * TFM6). A row with links has the pin and "Used in (N threads)" in its menu.
 */
export function FileMapRail({
  tree,
  workspaceName,
  map,
  hasLinks,
  usedIn,
  railRef,
}: {
  readonly tree: FileTree;
  readonly workspaceName: string;
  readonly map: Pick<ThreadFileMapValue, "isPinned" | "togglePin" | "openFile">;
  /** The row has threads to draw lines to. */
  hasLinks(entry: FileEntry): boolean;
  /** The row's "Used in (N threads)" menu item, if it was used. */
  usedIn(entry: FileEntry): MenuBinding | undefined;
  readonly railRef: RefObject<HTMLElement | null>;
}) {
  const actions = useMemo<TreeActions>(
    () => ({
      onOpenFile: (entry) => map.openFile(entry.path),
      bindings: (entry) => {
        const used = usedIn(entry);
        const out: MenuBindings = {
          ...(entry.type === "file"
            ? { "open-file": { onSelect: () => map.openFile(entry.path) } }
            : {}),
          ...(used ? { "file-used-in": used } : {}),
        };
        return out;
      },
      onRename: nothing,
      onDelete: nothing,
      onMove: nothing,
      onUpload: nothing,
      // Everything reads as read-only here: F2 and Delete do nothing.
      checkedOut: new Set<string>(),
      trailing: (entry) =>
        hasLinks(entry) ? (
          <LinePin side="file" pathOrId={entry.path} name={entry.name} map={map} />
        ) : null,
    }),
    [map, hasLinks, usedIn],
  );
  return (
    <section
      ref={railRef}
      aria-label="Workspace files"
      data-kobe-file-rail=""
      // Fills the rail's column (KOBE-614): the whole height and width, scrolling inside.
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-1 overflow-auto"
    >
      {/* Not a heading: the panel's headings are the thread groups'. */}
      <div className="flex h-6.5 items-center gap-1 ps-0.5 text-xs font-medium">
        <LayersIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate" title={workspaceName || undefined}>
          {workspaceName ? `Workspace: ${workspaceName}` : "Workspace"}
        </span>
        <IconAction
          command="refresh-files"
          size="sm"
          side="left"
          variant="ghost"
          className="text-foreground shrink-0"
          onClick={tree.reloadAll}
        />
      </div>
      <FileTreeView
        tree={tree}
        label="Workspace files"
        idPrefix="kobe-threads-file-row"
        dragRows={false}
        actions={actions}
        focusRequest={null}
        onFocusChange={nothing}
        header={() => null}
      />
      {tree.root.error && (
        <p role="alert" className="text-muted-foreground m-0 text-xs">
          Your files could not be listed.{" "}
          <button
            type="button"
            className="border-0 bg-transparent p-0 underline"
            onClick={tree.reloadAll}
          >
            Try again
          </button>
        </p>
      )}
      {!tree.root.loading && !tree.root.error && tree.rows.length === 0 && (
        <p className="text-muted-foreground m-0 text-xs">No files yet.</p>
      )}
    </section>
  );
}
