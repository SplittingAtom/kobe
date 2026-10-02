import { describe, expect, it } from "vitest";
import {
  compareObjects,
  parseObjectList,
  serializeObjectList,
  unlistedReferences,
  type StoredObject,
} from "./objects.js";

const a: StoredObject = { key: "teams/t1/a.bin", size: 10, etag: '"e1"' };
const b: StoredObject = { key: "teams/t1/b.bin", size: 20, etag: '"e2"' };

describe("object list", () => {
  it("round-trips as JSON lines", () => {
    const text = serializeObjectList([a, b]);
    expect(text.split("\n").filter(Boolean)).toHaveLength(2);
    expect(parseObjectList(text)).toEqual([a, b]);
  });

  it("parses an empty list", () => {
    expect(parseObjectList("")).toEqual([]);
  });

  it("rejects malformed lines with their line number", () => {
    expect(() => parseObjectList('{"key":"x","size":-1,"etag":""}\n')).toThrow(/line 1/);
    expect(() => parseObjectList("nope\n")).toThrow(/line 1/);
  });
});

describe("compareObjects", () => {
  it("reports missing, resized, retagged and extra objects", () => {
    const actual: StoredObject[] = [
      { ...b, size: 21 },
      { key: "new.bin", size: 1, etag: '"n"' },
    ];
    const diff = compareObjects([a, b], actual);
    expect(diff.missing).toEqual([a]);
    expect(diff.sizeMismatch).toEqual([{ key: b.key, expected: 20, actual: 21 }]);
    expect(diff.extra).toBe(1);
  });

  it("reports ETag differences (a same-size object may hold other content)", () => {
    const diff = compareObjects([a], [{ ...a, etag: '"other"' }]);
    expect(diff.missing).toEqual([]);
    expect(diff.sizeMismatch).toEqual([]);
    expect(diff.etagMismatch).toEqual([{ key: a.key, expected: '"e1"', actual: '"other"' }]);
  });
});

describe("unlistedReferences", () => {
  it("returns referenced keys missing from the listing, once each", () => {
    expect(unlistedReferences([a.key, "gone.bin", "gone.bin"], [a, b])).toEqual(["gone.bin"]);
    expect(unlistedReferences([], [a])).toEqual([]);
  });
});
