import { describe, expect, it } from "vitest";
import { projectSlugSchema } from "@kobe/protocol";
import { deriveSlug, slugCandidates } from "./slug.js";
import { truncateUtf8 } from "./run-context.js";

describe("project slug", () => {
  it("derives a valid mount folder from a name", () => {
    expect(deriveSlug("Q3 Planning & Budget!")).toBe("q3-planning-budget");
    expect(deriveSlug("Ünïcode Café")).toBe("unicode-cafe");
    expect(deriveSlug("!!!")).toBe("project");
    const long = deriveSlug("a".repeat(100));
    expect(projectSlugSchema.safeParse(long).success).toBe(true);
  });

  it("suffixes a taken slug within the length limit", () => {
    const names = [...slugCandidates("a".repeat(40), 3)];
    expect(names).toHaveLength(3);
    for (const n of names) expect(projectSlugSchema.safeParse(n).success).toBe(true);
    expect(names[1]?.endsWith("-2")).toBe(true);
  });
});

describe("truncateUtf8", () => {
  it("leaves short text alone and cuts long text on a character boundary", () => {
    expect(truncateUtf8("hello", 10)).toEqual({ text: "hello", truncated: false });
    const cut = truncateUtf8("ééééé", 5);
    expect(cut).toEqual({ text: "éé", truncated: true });
    expect(Buffer.byteLength(cut.text)).toBeLessThanOrEqual(5);
  });
});
