import { describe, expect, it } from "vitest";
import { promotedFolderMessage, promoteFolderRequestSchema } from "./index.js";

/** KOBE-586 (PF3): the promote request is strict, name only beside the path (no visibility). */
describe("promoteFolderRequestSchema", () => {
  it("takes a workspace path and a project name", () => {
    expect(promoteFolderRequestSchema.safeParse({ path: "docs/q3", name: "Q3" }).success).toBe(
      true,
    );
  });

  it("refuses unknown keys, the retired visibility among them", () => {
    for (const body of [
      { path: "docs", name: "Docs", visibility: "workspace" },
      { path: "docs", name: "Docs", slug: "docs" },
    ]) {
      expect(promoteFolderRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it("refuses bad paths and names", () => {
    for (const body of [
      { path: "", name: "Docs" },
      { path: "../etc", name: "Docs" },
      { path: "/abs", name: "Docs" },
      { path: "docs", name: "   " },
      { path: "docs", name: "x".repeat(101) },
      { path: "docs" },
    ]) {
      expect(promoteFolderRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it("words the first commit after the folder", () => {
    expect(promotedFolderMessage("docs/q3")).toBe("Imported from My files/docs/q3");
  });
});
