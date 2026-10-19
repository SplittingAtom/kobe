import { describe, expect, it } from "vitest";
import { appInputDigest, canonicalToolInput } from "./input-canonical.js";

const SCHEMA = {
  type: "object",
  properties: {
    depth: { type: "integer", default: 2 },
    ratio: { type: "number" },
    deep: { type: "boolean" },
    name: { type: "string" },
    note: { type: "string" },
    nested: { type: "object", properties: { n: { type: "integer", default: 1 } } },
    list: { type: "array", items: { type: "integer" } },
  },
  required: ["name"],
};

describe("app input canonicalisation (KOBE-441: what Pi sends vs what the proxy captured)", () => {
  it("coerces what Pi coerces and applies the schema's defaults, on either side alike", () => {
    // Pi's tool.call keeps the model's raw arguments; Pi sends the converted ones upstream.
    const pi = { depth: "5", ratio: "0.5", deep: "true", name: "t", list: ["1", 2] };
    const proxy = { depth: 5, ratio: 0.5, deep: true, name: "t", list: [1, 2] };
    expect(canonicalToolInput(SCHEMA, pi)).toEqual(canonicalToolInput(SCHEMA, proxy));
    expect(appInputDigest(SCHEMA, pi)).toBe(appInputDigest(SCHEMA, proxy));
    // A default left out on one side and present on the other.
    expect(appInputDigest(SCHEMA, { name: "t" })).toBe(
      appInputDigest(SCHEMA, { name: "t", depth: 2 }),
    );
    expect(canonicalToolInput(SCHEMA, { name: "t", nested: {} })).toEqual({
      name: "t",
      depth: 2,
      nested: { n: 1 },
    });
    // An optional null is dropped (Pi's normalizeOptionalNulls); a required one is kept.
    expect(appInputDigest(SCHEMA, { name: "t", note: null })).toBe(
      appInputDigest(SCHEMA, { name: "t" }),
    );
  });

  it("never matches different values: it is exact after canonicalisation", () => {
    expect(appInputDigest(SCHEMA, { name: "t", depth: "5" })).not.toBe(
      appInputDigest(SCHEMA, { name: "t", depth: 6 }),
    );
    expect(appInputDigest(SCHEMA, { name: "t", depth: "5x" })).not.toBe(
      appInputDigest(SCHEMA, { name: "t", depth: 5 }),
    );
    expect(appInputDigest(SCHEMA, { name: "t", depth: "5.5" })).not.toBe(
      appInputDigest(SCHEMA, { name: "t", depth: 5 }),
    );
    expect(appInputDigest(SCHEMA, { name: "a" })).not.toBe(appInputDigest(SCHEMA, { name: "b" }));
    expect(appInputDigest(SCHEMA, { name: "t", extra: 1 })).not.toBe(
      appInputDigest(SCHEMA, { name: "t" }),
    );
    expect(appInputDigest(SCHEMA, { name: "t", deep: "yes" })).not.toBe(
      appInputDigest(SCHEMA, { name: "t", deep: true }),
    );
  });

  it("leaves input alone where the schema says nothing", () => {
    expect(canonicalToolInput({ type: "object" }, { a: "5" })).toEqual({ a: "5" });
    expect(canonicalToolInput(undefined, { a: "5" })).toEqual({ a: "5" });
  });
});
