import { describe, expect, it } from "vitest";
import {
  ITEM_REFERENCES_MAX,
  itemReferencesFieldSchema,
  splitItemReferences,
  withItemReferences,
} from "./item-references.js";
import { submitMessageBodySchema } from "./run-orchestrator.js";

const orders = { name: "cat.ns.orders", kind: "table" };
const recent = { name: "cat.ns.recent", kind: "view" };

describe("item references (KOBE-490)", () => {
  it("appends the server's line after the member's text and splits it back", () => {
    const input = withItemReferences([orders, recent], "Compare these.\n\nThanks");
    expect(input).toBe(
      "Compare these.\n\nThanks\n\nReferenced: `cat.ns.orders` (table), `cat.ns.recent` (view)",
    );
    expect(splitItemReferences(input)).toEqual({
      references: [orders, recent],
      rest: "Compare these.\n\nThanks",
    });
    expect(withItemReferences([], "hi")).toBe("hi");
    expect(splitItemReferences("hi")).toEqual({ references: [], rest: "hi" });
  });

  it("keeps names with commas, parentheses and spaces inside the quotes", () => {
    const odd = { name: "a, b (c).d e", kind: "item" };
    expect(splitItemReferences(withItemReferences([odd], "x")).references).toEqual([odd]);
  });

  it("recognises the line only at the end, after a blank line", () => {
    expect(splitItemReferences("Referenced: `a` (table)").references).toEqual([]);
    expect(splitItemReferences("x\n\nReferenced: `a` (table)\nmore").references).toEqual([]);
    expect(splitItemReferences("x\nReferenced: `a` (table)").references).toEqual([]);
  });

  it("bounds the field: names, kinds, count and duplicates", () => {
    expect(itemReferencesFieldSchema.safeParse([orders, recent]).success).toBe(true);
    for (const bad of [
      [],
      [{ name: "a`b", kind: "table" }],
      [{ name: "a\nb", kind: "table" }],
      [{ name: "a\u202eb", kind: "table" }],
      [{ name: " a", kind: "table" }],
      [{ name: "x".repeat(513), kind: "table" }],
      [{ name: "a", kind: "Table" }],
      [{ name: "a", kind: "t".repeat(33) }],
      [{ name: "a", kind: "table", uri: "x://y" }],
      [orders, orders],
      Array.from({ length: ITEM_REFERENCES_MAX + 1 }, (_, i) => ({ name: `n${i}`, kind: "table" })),
    ]) {
      expect(itemReferencesFieldSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(itemReferencesFieldSchema.safeParse([orders, { ...orders, kind: "view" }]).success).toBe(
      true,
    );
  });

  it("is an optional field of a sent message", () => {
    expect(submitMessageBodySchema.safeParse({ content: "hi", references: [orders] }).success).toBe(
      true,
    );
    expect(submitMessageBodySchema.safeParse({ content: "hi", references: [] }).success).toBe(
      false,
    );
  });

  it("round-trips the most references the field allows", () => {
    const refs = Array.from({ length: ITEM_REFERENCES_MAX }, (_, i) => ({
      name: `c.n.t${i}`,
      kind: "table",
    }));
    expect(splitItemReferences(withItemReferences(refs, "q")).references).toEqual(refs);
  });
});
