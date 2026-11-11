import { describe, expect, it } from "vitest";
import { buildGuide } from "./guide-loader";
import { groupBySection, pageBySlug, prevNext, sectionId } from "./guide";

const fm = (title: string, section: string, order: number) =>
  `---\ntitle: ${title}\nsummary: S.\nsection: ${section}\norder: ${order}\n---\nText.\n`;

const PAGES = buildGuide([
  { path: "a.md", content: fm("A", "Getting started", 1) },
  { path: "b.md", content: fm("B", "Getting started", 2) },
  { path: "c.md", content: fm("C", "Reference", 1) },
]);

describe("guide lookups (KOBE-616)", () => {
  it("groups pages by section in nav order, skipping empty sections", () => {
    expect(groupBySection(PAGES).map((g) => [g.id, g.pages.map((p) => p.slug)])).toEqual([
      ["getting-started", ["a", "b"]],
      ["reference", ["c"]],
    ]);
    expect(sectionId("Internet access and approvals")).toBe("internet-access-and-approvals");
  });
  it("finds pages and their neighbours across sections", () => {
    expect(pageBySlug("c", PAGES)?.title).toBe("C");
    expect(pageBySlug("zz", PAGES)).toBeNull();
    expect(prevNext("b", PAGES)).toMatchObject({ prev: { slug: "a" }, next: { slug: "c" } });
    expect(prevNext("a", PAGES).prev).toBeNull();
  });
  it("builds the repository's guide (docs/guide) into the bundle", async () => {
    const { PAGES: built } = await import("./guide");
    expect(built.length).toBeGreaterThan(0);
    expect(built.every((p) => p.title && p.summary)).toBe(true);
  });
});
