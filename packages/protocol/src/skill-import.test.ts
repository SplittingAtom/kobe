import { describe, expect, it } from "vitest";
import { registryImportAllowlistSchema } from "./skill-registry-settings.js";
import { importAllowed, skillImportRequestSchema } from "./skill-import.js";

const SHA = "a".repeat(40);

describe("governed import contract (KOBE-344)", () => {
  it("needs a full commit SHA for git and a SHA-256 for a zip; never a branch (ac-1, ac-2)", () => {
    const ok = { kind: "git", url: "https://github.com/acme/skills", commit: SHA };
    expect(skillImportRequestSchema.safeParse(ok).success).toBe(true);
    expect(skillImportRequestSchema.safeParse({ ...ok, path: "skills/pdf" }).success).toBe(true);
    for (const bad of [
      { ...ok, commit: "main" },
      { ...ok, commit: "abc123" },
      { kind: "git", url: ok.url },
      { ...ok, url: "http://github.com/acme/skills" },
      { ...ok, url: "https://tok@github.com/acme/skills" },
      { ...ok, url: "https://github.com:8443/acme/skills" },
      { ...ok, url: "https://github.com/acme/skills?ref=main" },
      { ...ok, path: "../etc" },
      { kind: "zip", url: "https://example.org/s.zip" },
    ])
      expect(skillImportRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(
      skillImportRequestSchema.safeParse({
        kind: "zip",
        url: "https://example.org/s.zip",
        sha256: "b".repeat(64),
      }).success,
    ).toBe(true);
  });

  it("allows hosts and host/owner entries only; default none", () => {
    expect(registryImportAllowlistSchema.safeParse(["github.com", "github.com/acme"]).success).toBe(
      true,
    );
    for (const bad of ["github.com/acme/x", "https://github.com", "github.com/", "GitHub.com/a"])
      expect(registryImportAllowlistSchema.safeParse([bad]).success, bad).toBe(false);
    expect(importAllowed([], "https://github.com/acme/s")).toBe(false);
    expect(importAllowed(["github.com/acme"], "https://github.com/ACME/s")).toBe(true);
    expect(importAllowed(["github.com/acme"], "https://github.com/other/s")).toBe(false);
    expect(importAllowed(["github.com"], "https://github.com/other/s")).toBe(true);
    expect(importAllowed(["github.com"], "https://api.github.com/x")).toBe(false);
    expect(importAllowed(["github.com"], "https://github.com.evil.org/x")).toBe(false);
  });
});
