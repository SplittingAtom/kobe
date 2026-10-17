/**
 * A workspace row being dragged (KOBE-304 tree, KOBE-374 composer). The drag carries its own
 * types, never `Files`, so the rail's upload zone and the composer's attachments ignore it and
 * files from the computer are never mistaken for it. Browsers hide a drag's data until the drop,
 * so whether it is a folder is a type of its own, readable while hovering.
 */

/** The dragged row's workspace path (relative to `/workspace`). */
export const TREE_DRAG_TYPE = "application/x-kobe-workspace-path";
/** Present when the dragged row is a folder (folders move, but can't be mentioned). */
export const TREE_DRAG_FOLDER_TYPE = "application/x-kobe-workspace-folder";

export interface DraggedRow {
  readonly path: string;
  readonly type: "file" | "dir";
}

const typesOf = (dt: DataTransfer | null): readonly string[] => Array.from(dt?.types ?? []);

/** Starts a row's drag: `movable` rows may move in the tree; every file may be mentioned. */
export function startRowDrag(dt: DataTransfer, row: DraggedRow, movable: boolean): void {
  dt.setData(TREE_DRAG_TYPE, row.path);
  if (row.type === "dir") dt.setData(TREE_DRAG_FOLDER_TYPE, "");
  dt.effectAllowed = movable ? "copyMove" : "copy";
}

/** True while the drag is a workspace row (not files from the computer, text or a link). */
export const carriesWorkspaceRow = (dt: DataTransfer | null): boolean =>
  typesOf(dt).includes(TREE_DRAG_TYPE);

/** True while the dragged workspace row is a folder. */
export const carriesWorkspaceFolder = (dt: DataTransfer | null): boolean =>
  typesOf(dt).includes(TREE_DRAG_FOLDER_TYPE);

/** The dropped row's path; only readable in the drop event. Empty when there is none. */
export const droppedRowPath = (dt: DataTransfer): string => dt.getData(TREE_DRAG_TYPE);
