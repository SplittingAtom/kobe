import { describe, expect, it } from "vitest";
import { attachmentPaths } from "./attach-names.js";

const T = "11111111-1111-4111-8111-111111111111";
const id = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;

describe("attachmentPaths", () => {
  it("puts files under uploads/<thread>/<name>", () => {
    const paths = attachmentPaths(T, [{ id: id(1), name: "sales.csv" }]);
    expect(paths.get(id(1))).toBe(`uploads/${T}/sales.csv`);
  });

  it("numbers repeated names before the extension, in order", () => {
    const paths = attachmentPaths(T, [
      { id: id(1), name: "a.txt" },
      { id: id(2), name: "a.txt" },
      { id: id(3), name: "a.txt" },
      { id: id(4), name: "noext" },
      { id: id(5), name: "noext" },
    ]);
    expect([1, 2, 3, 4, 5].map((n) => paths.get(id(n)))).toEqual([
      `uploads/${T}/a.txt`,
      `uploads/${T}/a-2.txt`,
      `uploads/${T}/a-3.txt`,
      `uploads/${T}/noext`,
      `uploads/${T}/noext-2`,
    ]);
  });

  it("does not collide with a literal later name", () => {
    const paths = attachmentPaths(T, [
      { id: id(1), name: "a.txt" },
      { id: id(2), name: "a.txt" },
      { id: id(3), name: "a-2.txt" },
    ]);
    expect(new Set(paths.values()).size).toBe(3);
  });

  it("replaces a name the workspace cannot hold", () => {
    const paths = attachmentPaths(T, [
      { id: id(1), name: `x‮y.txt` },
      { id: id(2), name: "é".repeat(200) },
    ]);
    expect(paths.get(id(1))).toBe(`uploads/${T}/file-00000001`);
    expect(paths.get(id(2))).toBe(`uploads/${T}/file-00000002`);
  });
});
