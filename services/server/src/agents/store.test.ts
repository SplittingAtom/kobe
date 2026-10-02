import { describe, expect, it } from "vitest";
import { pickSlug } from "./store.js";

describe("pickSlug", () => {
  it("keeps a free slug and suffixes taken ones", () => {
    expect(pickSlug(new Set(), "writer")).toBe("writer");
    expect(pickSlug(new Set(["writer"]), "writer")).toBe("writer-2");
    expect(pickSlug(new Set(["writer", "writer-2"]), "writer")).toBe("writer-3");
  });

  it("stays within the slug length and never leaves a double hyphen", () => {
    const base = `${"a".repeat(45)}-bc`;
    const slug = pickSlug(new Set([base]), base);
    expect(slug).toBe(`${"a".repeat(45)}-2`);
    expect(slug?.length).toBeLessThanOrEqual(48);
  });

  it("gives up after 999 attempts", () => {
    const taken = new Set(["x", ...Array.from({ length: 998 }, (_, i) => `x-${i + 2}`)]);
    expect(pickSlug(taken, "x")).toBeNull();
  });
});
