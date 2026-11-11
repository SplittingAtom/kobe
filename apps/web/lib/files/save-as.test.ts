import { describe, expect, it } from "vitest";
import { defaultSaveAsPath, saveAsProblem } from "./save-as";

/** KOBE-615 ac-3: where Save As starts and which paths it refuses. */
describe("defaultSaveAsPath", () => {
  it("names a copy beside a writable file", () => {
    expect(defaultSaveAsPath("docs/notes.md")).toBe("docs/notes-copy.md");
    expect(defaultSaveAsPath("Makefile")).toBe("Makefile-copy");
    expect(defaultSaveAsPath(".env")).toBe(".env-copy");
    expect(defaultSaveAsPath("a/b.tar.gz")).toBe("a/b.tar-copy.gz");
  });

  it("starts at the top of My files for a read-only file", () => {
    expect(defaultSaveAsPath("projects/p1/docs/readme.md")).toBe("readme.md");
    expect(defaultSaveAsPath("uploads/t1/data.csv")).toBe("data.csv");
    // A checked-out project's files are writable: the copy goes beside.
    expect(defaultSaveAsPath("projects/p1/readme.md", new Set(["p1"]))).toBe(
      "projects/p1/readme-copy.md",
    );
  });
});

describe("saveAsProblem", () => {
  it("accepts a path of My files", () => {
    expect(saveAsProblem("notes/copy.md", "notes.md")).toBeNull();
    expect(saveAsProblem("projects/p1/x.md", "notes.md", new Set(["p1"]))).toBeNull();
  });

  it("refuses empty, this file, folders, bad and read-only paths", () => {
    expect(saveAsProblem("", "a.md")).toMatch(/Type a path/u);
    expect(saveAsProblem(" a.md", "b.md")).toMatch(/space/u);
    expect(saveAsProblem("a.md", "a.md")).toMatch(/That is this file/u);
    expect(saveAsProblem("docs/", "a.md")).toMatch(/file's name/u);
    expect(saveAsProblem("/abs.md", "a.md")).toMatch(/inside My files/u);
    expect(saveAsProblem("a//b.md", "a.md")).toMatch(/inside My files/u);
    expect(saveAsProblem("a/../b.md", "a.md")).toMatch(/inside My files/u);
    expect(saveAsProblem("a$b.md", "a.md")).toMatch(/inside My files/u);
    expect(saveAsProblem(".kobe/x.md", "a.md")).toMatch(/not available/u);
    expect(saveAsProblem("projects/p1/x.md", "a.md")).toMatch(/read-only/u);
    expect(saveAsProblem("uploads/t1/x.md", "a.md")).toMatch(/read-only/u);
  });
});
