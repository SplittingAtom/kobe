import { describe, expect, it } from "vitest";
import { pairRenames } from "./renames.js";

const A = "a".repeat(64);
const B = "b".repeat(64);

describe("rename detection in a sandbox commit (KOBE-516)", () => {
  it("pairs a path gone with the one new path holding its content", () => {
    expect(
      pairRenames([{ path: "notes/a.md", sha256: A }], [{ path: "archive/b.md", sha256: A }]),
    ).toEqual([{ from: "notes/a.md", to: "archive/b.md" }]);
  });

  it("pairs every file of a folder move, by name where contents repeat", () => {
    expect(
      pairRenames(
        [
          { path: "src/x.txt", sha256: A },
          { path: "src/y.txt", sha256: A },
          { path: "src/z.txt", sha256: B },
        ],
        [
          { path: "lib/y.txt", sha256: A },
          { path: "lib/x.txt", sha256: A },
          { path: "lib/z.txt", sha256: B },
        ],
      ),
    ).toEqual([
      { from: "src/x.txt", to: "lib/x.txt" },
      { from: "src/y.txt", to: "lib/y.txt" },
      { from: "src/z.txt", to: "lib/z.txt" },
    ]);
  });

  it("names no move it cannot attribute", () => {
    // Other content: a delete and an unrelated new file.
    expect(pairRenames([{ path: "a.md", sha256: A }], [{ path: "b.md", sha256: B }])).toEqual([]);
    // Two copies of the content, neither with the old name: which one is the move?
    expect(
      pairRenames(
        [{ path: "a.md", sha256: A }],
        [
          { path: "b.md", sha256: A },
          { path: "c.md", sha256: A },
        ],
      ),
    ).toEqual([]);
    // Two files with the same name and content went, one came: not attributable either.
    expect(
      pairRenames(
        [
          { path: "p/a.md", sha256: A },
          { path: "q/a.md", sha256: A },
        ],
        [{ path: "r/a.md", sha256: A }],
      ),
    ).toEqual([]);
    expect(pairRenames([{ path: "a.md", sha256: A }], [])).toEqual([]);
  });
});
