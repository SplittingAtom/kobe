// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "./api";
import {
  ancestorsOf,
  canMoveInto,
  canUploadInto,
  EXPANDED_MAX,
  expandedKey,
  isProjectMount,
  movedPath,
  readExpanded,
  visibleRows,
  writeExpanded,
  type FolderLoad,
} from "./tree";

const THREAD = "uploads/0b7f3c1e-2d4a-4e5b-8c6d-7e8f9a0b1c2d";

const e = (path: string, type: "file" | "dir" = "file"): FileEntry => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  type,
  sizeBytes: type === "dir" ? null : 1,
  mtime: "2026-10-01T10:00:00Z",
  source: "synced",
  area: "workspace",
});
const load = (entries: FileEntry[], nextCursor: string | null = null): FolderLoad => ({
  entries,
  nextCursor,
  loading: false,
  error: null,
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("visible rows (KOBE-304)", () => {
  it("walks expanded folders depth first, with levels, positions and Show more", () => {
    const folders = new Map([
      ["", load([e("a", "dir"), e("b", "dir"), e(".kobe", "dir"), e("z.txt")])],
      ["a", load([e("a/x.txt"), e("a/y.txt"), e("a/z.txt")])],
      ["b", load([e("b/1")], "c")],
    ]);
    const rows = visibleRows(folders, new Set(["a", "b"]), new Map([["a", 2]]));
    expect(
      rows.map((r) =>
        r.kind === "entry"
          ? `${r.level}:${r.entry.path}:${r.posinset}/${r.setsize}`
          : `${r.level}:more:${r.folder}:${r.hidden}`,
      ),
    ).toEqual([
      "1:a:1/3",
      "2:a/x.txt:1/3",
      "2:a/y.txt:2/3",
      "2:more:a:1",
      "1:b:2/3",
      "2:b/1:1/1",
      "2:more:b:-1",
      "1:z.txt:3/3",
    ]);
  });

  it("marks an expanded folder whose listing is still on its way", () => {
    const rows = visibleRows(new Map([["", load([e("a", "dir")])]]), new Set(["a"]), new Map());
    expect(rows[0]).toMatchObject({ kind: "entry", expanded: true, loading: true });
  });
});

describe("move rules (KOBE-304)", () => {
  it("allows moves into writable folders only, never into itself or where it already is", () => {
    expect(canMoveInto("a.txt", "file", "notes")).toBe(true);
    expect(canMoveInto("notes/a.txt", "file", "")).toBe(true);
    expect(canMoveInto("notes/a.txt", "file", "notes")).toBe(false);
    expect(canMoveInto("notes", "dir", "notes/sub")).toBe(false);
    expect(canMoveInto("notes", "dir", "notes")).toBe(false);
    expect(canMoveInto("notes", "dir", "notesX")).toBe(true);
    expect(canMoveInto("a.txt", "file", "projects/p")).toBe(false);
    expect(canMoveInto("projects/p/a", "file", "")).toBe(false);
    expect(canMoveInto("a.txt", "file", THREAD)).toBe(false);
    expect(canMoveInto("a.txt", "file", "uploads")).toBe(true); // becomes a drop
    expect(canMoveInto("notes", "dir", "uploads")).toBe(false);
    expect(canMoveInto("uploads/drop.pdf", "file", "notes")).toBe(true);
    expect(canMoveInto(`${THREAD}/brief.pdf`, "file", "notes")).toBe(false);
  });

  it("uploads from the computer go into the top level, uploads/ and writable folders", () => {
    expect(canUploadInto("")).toBe(true);
    expect(canUploadInto("uploads")).toBe(true);
    expect(canUploadInto("notes")).toBe(true);
    expect(canUploadInto("projects")).toBe(false);
    expect(canUploadInto("projects/p")).toBe(false);
    expect(canUploadInto(THREAD)).toBe(false);
  });

  it("maps paths through a move, and knows project mounts", () => {
    expect(movedPath("a/b/c", "a/b", "x")).toBe("x/c");
    expect(movedPath("a/bc", "a/b", "x")).toBe("a/bc");
    expect(ancestorsOf("a/b/c")).toEqual(["a", "a/b"]);
    expect(isProjectMount("projects")).toBe(true);
    expect(isProjectMount("projects/p")).toBe(true);
    expect(isProjectMount("projects/p/x")).toBe(false);
  });
});

describe("remembered expansion (KOBE-304)", () => {
  it("round-trips per team, ignores garbage and caps its size", () => {
    const key = expandedKey("t1");
    writeExpanded(key, new Set(["a", "a/b"]));
    expect([...readExpanded(key)]).toEqual(["a", "a/b"]);
    expect([...readExpanded(expandedKey("t2"))]).toEqual([]);
    localStorage.setItem(key, "{not json");
    expect(readExpanded(key).size).toBe(0);
    localStorage.setItem(key, JSON.stringify([1, "", "ok", null]));
    expect([...readExpanded(key)]).toEqual(["ok"]);
    writeExpanded(key, new Set(Array.from({ length: EXPANDED_MAX + 5 }, (_, i) => `f${i}`)));
    expect(readExpanded(key).size).toBe(EXPANDED_MAX);
    writeExpanded(key, new Set());
    expect(localStorage.getItem(key)).toBeNull();
  });
});
