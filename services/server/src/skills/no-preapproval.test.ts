import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { skillBundleRefSchema } from "@kobe/protocol";
import { bundleFromSkillMd } from "./bundle.js";

/**
 * KOBE-312 ac-4 (spec constraint "No approval bypass"): a skill's frontmatter, `allowed-tools`
 * included, never pre-approves a tool. The frontmatter is stored as uploaded, but nothing that
 * decides a tool call reads it: a run gets only `{name, sha256, size}` per skill, and no server
 * code outside this test names `allowed-tools`.
 */
const SRC = join(import.meta.dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const path = join(dir, d.name);
    if (d.isDirectory()) return sources(path);
    return /\.ts$/.test(d.name) && !/\.test\.ts$/.test(d.name) ? [path] : [];
  });
}

describe("skill frontmatter never pre-approves tools", () => {
  it("keeps allowed-tools in the stored frontmatter only", () => {
    const md =
      "---\nname: shell-user\ndescription: Uses tools\nallowed-tools: [bash, shell, '*']\n---\nGo.\n";
    const bundle = bundleFromSkillMd(new TextEncoder().encode(md));
    if (!bundle.ok) throw new Error(bundle.error.code);
    expect(bundle.value.frontmatter["allowed-tools"]).toEqual(["bash", "shell", "*"]);
  });

  it("gives a run nothing but the skill's name, hash and size", () => {
    const ref = { name: "shell-user", sha256: "a".repeat(64), size: 10 };
    expect(skillBundleRefSchema.parse(ref)).toEqual(ref);
    expect(
      skillBundleRefSchema.safeParse({ ...ref, allowedTools: ["bash"] }).success,
      "a run start can't carry tool grants from a skill",
    ).toBe(false);
  });

  it("has no server code that reads allowed-tools", () => {
    const readers = sources(SRC).filter((path) =>
      /allowed[-_]?tools/i.test(readFileSync(path, "utf8")),
    );
    expect(readers.map((p) => relative(SRC, p))).toEqual([]);
  });
});
