import { describe, expect, it } from "vitest";
import type { FileEntry } from "../files/api";
import type { TreeRow } from "../files/tree";
import type { Project, ProjectFile } from "./api";
import { headListing, shapeProjectRows, unmountedDragRefusal } from "./files-panel";

const project = (slug: string, over: Partial<Project> = {}): Project =>
  ({
    id: `p-${slug}`,
    slug,
    name: slug.toUpperCase(),
    archivedAt: null,
    updatedAt: "2026-11-01T00:00:00Z",
    myRole: "editor",
    ...over,
  }) as Project;

const entry = (path: string, type: "file" | "dir" = "dir"): FileEntry => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  type,
  sizeBytes: null,
  mtime: "",
  source: "synced",
  area: "projects",
});
const top = (slug: string): Extract<TreeRow, { kind: "entry" }> => ({
  kind: "entry",
  entry: entry(`projects/${slug}`),
  level: 1,
  posinset: 1,
  setsize: 1,
  expanded: false,
  loading: false,
});
const child = (slug: string, name: string): TreeRow => ({
  ...top(slug),
  entry: entry(`projects/${slug}/${name}`, "file"),
  level: 2,
});
const slugs = (rows: readonly TreeRow[]) =>
  rows.flatMap((r) => (r.kind === "entry" && r.level === 1 ? [r.entry.name] : []));
const base = (list: Project[], over = {}) => ({
  projects: new Map(list.map((p) => [p.slug, p])),
  activeSlug: undefined,
  checkedOut: new Set<string>(),
  filter: "",
  showAll: false,
  ...over,
});

describe("shapeProjectRows", () => {
  const list = [project("b"), project("a"), project("c"), project("z", { archivedAt: "x" })];
  const rows = [top("b"), child("b", "f.txt"), top("a"), top("c"), top("z")];

  it("lists non-archived projects by name, the active one first, children following", () => {
    const shaped = shapeProjectRows(rows, base(list, { activeSlug: "c" }));
    expect(slugs(shaped.rows)).toEqual(["c", "a", "b"]);
    expect(shaped.total).toBe(3);
    const b = shaped.rows.findIndex((r) => r.kind === "entry" && r.entry.name === "b");
    expect(shaped.rows[b + 1]).toMatchObject({ entry: { name: "f.txt" } });
    expect(shaped.rows.filter((r) => r.kind === "entry" && r.level === 1)).toMatchObject([
      { posinset: 1, setsize: 3 },
      { posinset: 2 },
      { posinset: 3 },
    ]);
  });

  it("filters by name or slug", () => {
    expect(slugs(shapeProjectRows(rows, base(list, { filter: "B" })).rows)).toEqual(["b"]);
  });

  it("over 50 keeps the active, checked-out and the 50 most recent, then Show all", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      project(`p${String(i).padStart(2, "0")}`, {
        updatedAt: `2026-11-01T00:${String(i).padStart(2, "0")}:00Z`,
      }),
    );
    const all = many.map((p) => top(p.slug));
    const capped = shapeProjectRows(
      all,
      base(many, { activeSlug: "p00", checkedOut: new Set(["p01"]) }),
    );
    expect(capped.rows).toHaveLength(52);
    expect(capped.hidden).toBe(8);
    expect(slugs(capped.rows)[0]).toBe("p00");
    expect(slugs(capped.rows)).toContain("p01");
    const full = shapeProjectRows(all, base(many, { showAll: true }));
    expect(full.rows).toHaveLength(60);
    expect(full.hidden).toBe(0);
  });
});

describe("headListing", () => {
  const f = (path: string, sizeBytes = 5): ProjectFile =>
    ({ path, sizeBytes, addedAt: "2026-11-01T00:00:00Z" }) as ProjectFile;
  const files = [f("README.md"), f("src/a.ts"), f("src/lib/b.ts"), f("docs/x.md")];
  it("lists a project's top and a folder with mount-style paths, folders first", () => {
    expect(headListing(files, "ops", "").map((e) => [e.path, e.type])).toEqual([
      ["projects/ops/docs", "dir"],
      ["projects/ops/src", "dir"],
      ["projects/ops/README.md", "file"],
    ]);
    expect(headListing(files, "ops", "src").map((e) => e.path)).toEqual([
      "projects/ops/src/lib",
      "projects/ops/src/a.ts",
    ]);
  });
});

it("words the drag refusal", () => {
  expect(unmountedDragRefusal("Ops")).toBe("Start a conversation in Ops to mention its files");
});
