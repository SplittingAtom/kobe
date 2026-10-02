import { describe, expect, it } from "vitest";
import {
  CanonicalJsonError,
  MAX_CANONICAL_DEPTH,
  canonicalJson,
  canonicalJsonBytes,
} from "./index.js";

describe("canonicalJson (RFC 8785 + Kobe strictness)", () => {
  it("matches the RFC 8785 §3.2.2 example byte for byte", () => {
    const input = JSON.parse(String.raw`{
      "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
      "string": "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/",
      "literals": [null, true, false]
    }`);
    expect(canonicalJson(input)).toBe(
      String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`,
    );
  });

  it("sorts keys by UTF-16 code units (RFC 8785 §3.2.3 example)", () => {
    const input = JSON.parse(String.raw`{
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "\ud83d\ude00": "Emoji: Grinning Face",
      "\u0080": "Control",
      "\u00f6": "Latin Small Letter O With Diaeresis"
    }`);
    const order = [...canonicalJson(input).matchAll(/:"([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual([
      "Carriage Return",
      "One",
      "Control",
      "Latin Small Letter O With Diaeresis",
      "Euro Sign",
      "Emoji: Grinning Face",
      "Hebrew Letter Dalet With Dagesh",
    ]);
  });

  it("is independent of key insertion order, recursively", () => {
    const a = { b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } };
    const b = { a: { c: null, d: [3, { x: 2, y: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
  });

  it("keeps array order", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it.each([
    [0, "0"],
    [-0, "0"],
    [1, "1"],
    [-1.5, "-1.5"],
    [4.5, "4.5"],
    [1e21, "1e+21"],
    [1e-7, "1e-7"],
    [0.000001, "0.000001"],
    [9007199254740992, "9007199254740992"],
    [5e-324, "5e-324"],
    [1.7976931348623157e308, "1.7976931348623157e+308"],
    [0.1 + 0.2, "0.30000000000000004"],
  ])("serialises the number %s as %s", (value, expected) => {
    expect(canonicalJson(value)).toBe(expected);
  });

  it("does not normalise Unicode: NFC and NFD forms differ", () => {
    const nfc = "caf\u00e9";
    const nfd = "cafe\u0301";
    expect(canonicalJson({ p: nfc })).not.toBe(canonicalJson({ p: nfd }));
  });

  it("keeps non-ASCII, U+2028 and U+2029 literal and escapes control characters", () => {
    expect(canonicalJson("\u00e9\u2028\u2029\u0000\u001f\t")).toBe(
      '"\u00e9\u2028\u2029\\u0000\\u001f\\t"',
    );
  });

  it("encodes to UTF-8 bytes", () => {
    expect([...canonicalJsonBytes({ s: "\u20ac" })]).toEqual([
      0x7b, 0x22, 0x73, 0x22, 0x3a, 0x22, 0xe2, 0x82, 0xac, 0x22, 0x7d,
    ]);
    expect([...canonicalJsonBytes("\ud83d\ude00")]).toEqual([0x22, 0xf0, 0x9f, 0x98, 0x80, 0x22]);
  });

  it.each([
    ["undefined", undefined],
    ["undefined property", { a: undefined }],
    ["undefined in array", [undefined]],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["bigint", 1n],
    ["function", () => 1],
    ["symbol", Symbol("x")],
    ["Date", new Date(0)],
    ["Map", new Map()],
    ["lone high surrogate", "\ud800"],
    ["lone low surrogate", "x\udc00"],
    ["lone surrogate in key", { "\ud800": 1 }],
    ["sparse array", [1, , 3]], // eslint-disable-line no-sparse-arrays
    ["symbol key", { [Symbol("k")]: 1 }],
    ["__proto__ key", JSON.parse('{"a":{"__proto__":1}}')],
  ])("rejects %s", (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
  });

  it("accepts null-prototype objects", () => {
    const obj = Object.assign(Object.create(null) as Record<string, number>, { b: 2, a: 1 });
    expect(canonicalJson(obj)).toBe('{"a":1,"b":2}');
  });

  it("rejects nesting deeper than the limit and reports the path", () => {
    let deep: unknown = 1;
    for (let i = 0; i <= MAX_CANONICAL_DEPTH; i += 1) deep = [deep];
    expect(() => canonicalJson(deep)).toThrow(/nesting too deep/);
    expect(() => canonicalJson({ a: [1, { b: Number.NaN }] })).toThrow("at $.a[1].b");
  });
});
