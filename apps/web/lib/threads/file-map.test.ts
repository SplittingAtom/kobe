import { describe, expect, it } from "vitest";
import type { FileThreads, ThreadFileLinks } from "./file-links";
import {
  baseName,
  elsewhereText,
  fileCount,
  filesOf,
  hiddenFilesText,
  threadsUsing,
  usedInLabel,
} from "./file-map";

const file = (path: string, access: "read" | "write", deleted = false) => ({
  path,
  projectId: null,
  access,
  lastAt: "2026-11-10T10:00:00Z",
  deleted,
});
const links = (threadId: string, files: ReturnType<typeof file>[], hiddenCount = 0) =>
  ({ threadId, files, hiddenCount }) satisfies ThreadFileLinks;

describe("file-map", () => {
  it("filesOf leaves deleted files out of the line targets", () => {
    expect(filesOf(links("t", [file("a", "write"), file("b", "read", true)]))).toEqual([
      { key: "a", access: "write" },
    ]);
    expect(filesOf(undefined)).toEqual([]);
  });

  it("threadsUsing joins the file's read with the rows' links, write winning", () => {
    const byThread = new Map([
      ["t1", links("t1", [file("notes/a.md", "write")])],
      ["t2", links("t2", [file("notes/b.md", "read")])],
    ]);
    const byPath = new Map<string, FileThreads>([
      [
        "notes/a.md",
        {
          path: "notes/a.md",
          threads: [
            { threadId: "t1", title: "One", access: "read", lastAt: "x" },
            { threadId: "t9", title: "Nine", access: "read", lastAt: "x" },
          ],
          more: 0,
        },
      ],
    ]);
    expect(threadsUsing("notes/a.md", false, byThread, byPath)).toEqual([
      { threadId: "t1", title: "One", access: "write" },
      { threadId: "t9", title: "Nine", access: "read" },
    ]);
    expect(threadsUsing("notes", true, byThread, byPath).map((t) => t.threadId)).toEqual([
      "t1",
      "t2",
    ]);
    expect(threadsUsing("note", true, byThread, byPath)).toEqual([]);
  });

  it("words", () => {
    expect(fileCount(links("t", [file("a", "read")], 2))).toBe(3);
    expect(usedInLabel(1)).toBe("Used in (1 thread)");
    expect(usedInLabel(2)).toBe("Used in (2 threads)");
    expect(hiddenFilesText(1)).toBe("1 file you can't see");
    expect(baseName("a/b/c.md")).toBe("c.md");
    expect(elsewhereText(["a", "b", "c"], (id) => (id === "c" ? null : "Archived"))).toBe(
      "2 in Archived, 1 elsewhere",
    );
    expect(elsewhereText([], () => null)).toBe("");
  });
});
