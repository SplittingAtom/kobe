import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Project } from "../projects/api";
import { editBlockReason, editorLanguage, isTextPreview, sha256Hex } from "./editor";
import { previewOf } from "./preview";

describe("which files the editor opens (KOBE-463)", () => {
  it("every text preview kind is editable; images, HTML and unknown files are not", () => {
    for (const path of [
      "a.txt",
      "a.md",
      "a.csv",
      "a.tsv",
      "a.json",
      "a.py",
      "a.yaml",
      "Makefile",
    ]) {
      expect(isTextPreview(previewOf(path)), path).toBe(true);
    }
    for (const path of ["a.png", "a.svg", "a.html", "a.pdf", "a.bin"]) {
      expect(isTextPreview(previewOf(path)), path).toBe(false);
    }
  });

  it("a cut read, project files and thread uploads open read-only with a reason", () => {
    expect(editBlockReason("notes.md", false)).toBeUndefined();
    expect(editBlockReason("uploads/brief.md", false)).toBeUndefined(); // the member's own drop
    expect(editBlockReason("notes.md", true)).toMatch(/over 1 MB/);
    expect(editBlockReason("projects/p/readme.md", false)).toMatch(/read-only/);
    expect(editBlockReason("uploads/0b7e3c2a-1111-4222-8333-444455556666/a.md", false)).toMatch(
      /read-only/,
    );
  });

  it("a project file's reason follows what the member may do (CM3, FP3)", () => {
    const project = (slug: string, over: Partial<Project> = {}): Project => ({
      id: `p-${slug}`,
      teamId: "t",
      slug,
      name: slug,
      description: "",
      instructions: "",
      defaultAgentId: null,
      visibility: "workspace",
      myRole: "editor",
      fileCount: 0,
      createdBy: "u",
      createdAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-01T00:00:00Z",
      archivedAt: null,
      ...over,
    });
    const bySlug = new Map([
      ["budget", project("budget")],
      ["deck", project("deck", { myRole: "reader" })],
      ["old", project("old", { archivedAt: "2026-11-02T00:00:00Z" })],
    ]);
    const projects = { bySlug, checkedOut: new Set(["budget", "old"]) };
    expect(editBlockReason("projects/budget/plan.md", false, projects)).toBeUndefined();
    expect(
      editBlockReason("projects/budget/plan.md", false, { bySlug, checkedOut: new Set() }),
    ).toMatch(/check the project out/);
    expect(editBlockReason("projects/deck/a.md", false, projects)).toBe(
      "You can read this project, not change it.",
    );
    expect(editBlockReason("projects/old/a.md", false, projects)).toMatch(/archived/);
  });

  it("picks a language mode for md, json, csv, python, js, ts and yaml; plain text otherwise", () => {
    expect(editorLanguage(previewOf("a.md"))).toBe("markdown");
    expect(editorLanguage(previewOf("a.json"))).toBe("json");
    expect(editorLanguage(previewOf("a.ipynb"))).toBe("json");
    expect(editorLanguage(previewOf("a.csv"))).toBe("csv");
    expect(editorLanguage(previewOf("a.tsv"))).toBe("tsv");
    expect(editorLanguage(previewOf("a.py"))).toBe("python");
    expect(editorLanguage(previewOf("a.mjs"))).toBe("javascript");
    expect(editorLanguage(previewOf("a.jsx"))).toBe("jsx");
    expect(editorLanguage(previewOf("a.ts"))).toBe("typescript");
    expect(editorLanguage(previewOf("a.tsx"))).toBe("tsx");
    expect(editorLanguage(previewOf("a.yml"))).toBe("yaml");
    expect(editorLanguage(previewOf("a.txt"))).toBeNull();
    expect(editorLanguage(previewOf("a.rs"))).toBeNull();
  });
});

describe("the version the editor loaded", () => {
  it("is the SHA-256 of the bytes as lowercase hex, as the listing and proposals carry it", async () => {
    const bytes = new TextEncoder().encode("hello\n");
    expect(await sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
});
