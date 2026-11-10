import { describe, expect, it } from "vitest";
import { must } from "../testing/must";
import {
  anchorOf,
  curvePath,
  intersect,
  markerText,
  planLines,
  relativeBox,
  type Box,
  type LineSource,
  type TargetRail,
} from "./line-model";

const row = (top: number, left: number, right: number): Box => ({
  top,
  bottom: top + 20,
  left,
  right,
});
const VIEW: Box = { top: 0, bottom: 400, left: 0, right: 1000 };

const fileRail = (rows: Record<string, number>, viewport = VIEW): TargetRail => ({
  rows: new Map(Object.entries(rows).map(([k, top]) => [k, row(top, 600, 900)])),
  viewport,
});
const threadRail = (rows: Record<string, number>, viewport = VIEW): TargetRail => ({
  rows: new Map(Object.entries(rows).map(([k, top]) => [k, row(top, 250, 550)])),
  viewport,
});
const none: TargetRail = { rows: new Map(), viewport: VIEW };

const thread = (key: string, top: number, targets: LineSource["targets"]): LineSource => ({
  side: "thread",
  key,
  box: row(top, 250, 550),
  viewport: VIEW,
  targets,
});

describe("anchorOf", () => {
  const rows = new Map([
    ["notes", row(0, 0, 1)],
    ["notes/a.md", row(20, 0, 1)],
  ]);
  it("is the row itself when shown", () => {
    expect(anchorOf("notes/a.md", "file", rows)).toBe("notes/a.md");
  });
  it("is the nearest shown folder for a file in a closed one", () => {
    expect(anchorOf("notes/deep/b.md", "file", rows)).toBe("notes");
  });
  it("is nothing for a file with no shown ancestor, or a thread without a row", () => {
    expect(anchorOf("other/c.md", "file", rows)).toBeUndefined();
    expect(anchorOf("notes/x", "thread", new Map())).toBeUndefined();
  });
});

describe("planLines", () => {
  it("draws a thread's lines from its right edge to the files' left edges, by access", () => {
    const plan = planLines(
      [
        thread("t1", 100, [
          { key: "a.md", access: "write" },
          { key: "b.md", access: "read" },
        ]),
      ],
      { file: fileRail({ "a.md": 40, "b.md": 200 }), thread: none },
    );
    expect(plan.lines).toHaveLength(2);
    const [a, b] = plan.lines;
    expect(a).toMatchObject({ anchor: "a.md", access: "write", count: 1, aggregated: false });
    expect(a).toMatchObject({ x1: 550, y1: 110, x2: 600, y2: 50 });
    expect(b).toMatchObject({ anchor: "b.md", access: "read" });
    expect(plan.markers).toEqual([]);
    expect(plan.overflow).toBe(0);
  });

  it("links files in a closed folder to that folder with a count; write wins", () => {
    const plan = planLines(
      [
        thread("t1", 0, [
          { key: "notes/x/a.md", access: "read" },
          { key: "notes/b.md", access: "write" },
          { key: "notes/c.md", access: "read" },
        ]),
      ],
      { file: fileRail({ notes: 60 }), thread: none },
    );
    expect(plan.lines).toEqual([
      expect.objectContaining({ anchor: "notes", count: 3, access: "write", aggregated: true }),
    ]);
  });

  it("turns targets scrolled out of view into markers at the rail's edges", () => {
    const view: Box = { top: 100, bottom: 300, left: 0, right: 1000 };
    const plan = planLines(
      [
        {
          ...thread("t1", 150, [
            { key: "up.md", access: "read" },
            { key: "up2.md", access: "read" },
            { key: "here.md", access: "write" },
            { key: "down.md", access: "read" },
          ]),
          viewport: view,
        },
      ],
      {
        file: fileRail({ "up.md": 0, "up2.md": 20, "here.md": 150, "down.md": 500 }, view),
        thread: none,
      },
    );
    expect(plan.lines.map((l) => l.anchor)).toEqual(["here.md"]);
    expect(plan.markers).toEqual([
      expect.objectContaining({ side: "file", position: "above", count: 2, y: 100, x: 600 }),
      expect.objectContaining({ side: "file", position: "below", count: 1, y: 300 }),
    ]);
    expect(markerText(must(plan.markers[0]))).toBe("2 more above");
  });

  it("draws nothing for a source scrolled out of its own rail", () => {
    const plan = planLines([{ ...thread("t1", 900, [{ key: "a.md", access: "read" }]) }], {
      file: fileRail({ "a.md": 0 }),
      thread: none,
    });
    expect(plan.lines).toEqual([]);
    expect(plan.markers).toEqual([]);
  });

  it("counts targets with no row as unplaced", () => {
    const plan = planLines([thread("t1", 0, [{ key: "gone/a.md", access: "read" }])], {
      file: fileRail({}),
      thread: none,
    });
    expect(plan).toMatchObject({ lines: [], unplaced: 1 });
  });

  it("draws a file's lines to its threads, from the thread rows' right edges", () => {
    const plan = planLines(
      [
        {
          side: "file",
          key: "a.md",
          box: row(50, 600, 900),
          viewport: VIEW,
          targets: [
            { key: "t2", access: "read" },
            { key: "t1", access: "write" },
            { key: "elsewhere", access: "read" },
          ],
        },
      ],
      { file: none, thread: threadRail({ t1: 0, t2: 100 }) },
    );
    expect(plan.lines.map((l) => l.anchor)).toEqual(["t1", "t2"]);
    expect(plan.lines[0]).toMatchObject({ x1: 550, y1: 10, x2: 600, y2: 60, access: "write" });
    expect(plan.unplaced).toBe(1);
  });

  it("caps the lines, the first source's first, and counts the rest", () => {
    const files = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}`, i * 30]));
    const targets = Object.keys(files).map((key) => ({ key, access: "read" as const }));
    const plan = planLines(
      [thread("hovered", 0, targets.slice(0, 3)), thread("pinned", 40, targets)],
      { file: fileRail(files), thread: none },
      5,
    );
    expect(plan.lines).toHaveLength(5);
    expect(plan.lines.slice(0, 3).every((l) => l.sourceKey === "hovered")).toBe(true);
    expect(plan.overflow).toBe(6);
  });

  it("draws a source listed twice (hovered and pinned) once; merges markers", () => {
    const view: Box = { top: 100, bottom: 300, left: 0, right: 1000 };
    const src = {
      ...thread("t1", 150, [{ key: "up.md", access: "read" as const }]),
      viewport: view,
    };
    const other = { ...src, key: "t2" };
    const plan = planLines([src, src, other], {
      file: fileRail({ "up.md": 0 }, view),
      thread: none,
    });
    expect(plan.markers).toEqual([expect.objectContaining({ position: "above", count: 2 })]);
  });
});

describe("helpers", () => {
  it("curvePath is a horizontal S-curve", () => {
    expect(curvePath({ x1: 0, y1: 10, x2: 100, y2: 50 })).toBe("M 0 10 C 50 10, 50 50, 100 50");
  });
  it("relativeBox and intersect", () => {
    expect(relativeBox(row(120, 30, 60), { top: 100, left: 10 })).toEqual({
      top: 20,
      bottom: 40,
      left: 20,
      right: 50,
    });
    expect(intersect(row(0, 0, 100), { top: 10, bottom: 15, left: 50, right: 200 })).toEqual({
      top: 10,
      bottom: 15,
      left: 50,
      right: 100,
    });
    expect(intersect(row(0, 0, 10), row(100, 50, 60)).bottom).toBe(100);
  });
});
