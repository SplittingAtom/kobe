import { describe, expect, it } from "vitest";
import { must } from "../testing/must";
import type { FolderView } from "./folders-api";
import {
  canNestIn,
  deleteQuestion,
  folderPath,
  moveTargets,
  placeFolders,
  treeRows,
} from "./folder-tree";

const folder = (id: string, parentId: string | null, name: string, threads = 0, position = 0) =>
  ({ id, parentId, name, position, createdBy: "u", threads }) satisfies FolderView;

const FOLDERS = [
  folder("b", null, "Beta", 2),
  folder("a", null, "Alpha", 1),
  folder("a1", "a", "Sub", 3),
  folder("a11", "a1", "Deep"),
  folder("z", null, "Zed", 0, -1),
  folder("orphan", "gone", "Lost"),
];

describe("the folder tree model (KOBE-536, TF7)", () => {
  it("places folders depth first, siblings by position then name, orphans left out", () => {
    const placed = placeFolders(FOLDERS);
    expect(placed.map((p) => [p.folder.name, p.depth, p.descendantCount, p.height])).toEqual([
      ["Zed", 1, 0, 0],
      ["Alpha", 1, 2, 2],
      ["Sub", 2, 1, 1],
      ["Deep", 3, 0, 0],
      ["Beta", 1, 0, 0],
    ]);
  });

  it("shows Current, Archived only while Current is open, open folders' children, then Deleted", () => {
    const placed = placeFolders(FOLDERS);
    const counts = { current: 4, archived: 2, deleted: 1 };
    const closed = treeRows(placed, counts, { currentOpen: false, open: new Set() });
    expect(closed.map((r) => [r.label, r.level, r.expanded, r.count])).toEqual([
      ["Current", 1, false, 4],
      ["Zed", 1, undefined, 0],
      ["Alpha", 1, false, 1],
      ["Beta", 1, undefined, 2],
      ["Deleted", 1, undefined, 1],
    ]);
    const open = treeRows(placed, counts, { currentOpen: true, open: new Set(["a"]) });
    expect(open.map((r) => r.label)).toEqual([
      "Current",
      "Archived",
      "Zed",
      "Alpha",
      "Sub",
      "Beta",
      "Deleted",
    ]);
  });

  it("names paths, nests to three levels and moves only where the subtree fits", () => {
    const placed = placeFolders(FOLDERS);
    const by = (id: string) => must(placed.find((p) => p.folder.id === id));
    expect(folderPath(FOLDERS, "a11")).toBe("Alpha / Sub / Deep");
    expect(folderPath(FOLDERS, "nope")).toBeNull();
    expect(folderPath(FOLDERS, null)).toBeNull();
    expect(canNestIn(by("a1"))).toBe(true);
    expect(canNestIn(by("a11"))).toBe(false);
    // Alpha's subtree is three deep: it can only stay at the top level.
    expect(moveTargets(placed, by("a")).map((p) => p.folder.name)).toEqual([]);
    // Sub (two deep) fits under another top-level folder, not inside itself or its parent.
    expect(moveTargets(placed, by("a1")).map((p) => p.folder.name)).toEqual(["Zed", "Beta"]);
    expect(moveTargets(placed, by("z")).map((p) => p.folder.name)).toEqual([
      "Alpha",
      "Sub",
      "Beta",
    ]);
  });

  it("asks before deleting, naming the folders it takes along", () => {
    const placed = placeFolders(FOLDERS);
    expect(deleteQuestion(must(placed[1]))).toBe(
      "Delete “Alpha” and its 2 folders? The threads in them go back to their owners' Current.",
    );
    expect(deleteQuestion(must(placed[0]))).toBe(
      "Delete “Zed”? The threads in it go back to their owners' Current.",
    );
  });
});
