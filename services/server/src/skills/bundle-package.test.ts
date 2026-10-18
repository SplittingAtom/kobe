import { strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { describe, expect, it } from "vitest";
import { packageHash, runtimeHash } from "@kobe/protocol/node";
import { validateZipBundle } from "./bundle.js";
import { sha256Hex } from "./storage.js";

/**
 * Uploads under the KOBE-309 package contract (KOBE-310): authored packages that today's path
 * rules refuse are refused before anything is stored; `evals/` and `kobe.skill.yaml` stay in the
 * package but never reach the runtime zip a sandbox gets; a `kobe.skill.yaml` must be valid and
 * name the skill.
 */
const SKILL_MD = "---\nname: demo-skill\ndescription: Does demo things\n---\n# Demo\n";
const MANIFEST =
  "apiVersion: kobe.dev/skill/v1\nname: demo-skill\nversion: 1.2.0\nsummary: Demo.\nchangelog: Adds totals.\n";
const zip = (files: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])) as Zippable, {
    level: 6,
  });
const failure = (files: Record<string, string>) => {
  const result = validateZipBundle(zip({ "SKILL.md": SKILL_MD, ...files }));
  if (result.ok) throw new Error("expected a validation error");
  return result.error;
};
const names = (bytes: Uint8Array) => Object.keys(unzipSync(bytes)).sort();
const asMap = (files: Record<string, string>) =>
  new Map(Object.entries(files).map(([k, v]) => [k, strToU8(v)]));

describe("authored packages today's rules refuse", () => {
  it("refuses a root provenance.json: only Kobe writes one", () => {
    expect(failure({ "provenance.json": "{}" })).toMatchObject({ code: "reserved_path" });
  });

  it("refuses case variants of reserved names and a file named evals", () => {
    for (const path of ["Evals/cases.yaml", "KOBE.SKILL.YAML", "evals"])
      expect(failure({ [path]: "x" }).code, path).toBe("reserved_path");
  });

  it("refuses a path that is both a file and a folder", () => {
    expect(failure({ scripts: "x", "scripts/run.py": "y" })).toMatchObject({
      code: "path_conflict",
    });
  });

  it("refuses invisible and bidi characters in names", () => {
    expect(failure({ "scripts/run‮gnp.sh": "x" })).toMatchObject({ code: "unsafe_path" });
    expect(failure({ "a​b.md": "x" })).toMatchObject({ code: "unsafe_path" });
  });
});

describe("runtime and package zips", () => {
  it("keeps evals/ and kobe.skill.yaml out of the runtime zip and in the package", () => {
    const files = {
      "SKILL.md": SKILL_MD,
      "scripts/run.py": "print(1)\n",
      "evals/cases.yaml": "cases: []\n",
      "kobe.skill.yaml": MANIFEST,
    };
    const result = validateZipBundle(zip(files));
    if (!result.ok) throw new Error(result.error.code);
    const b = result.value;
    expect(names(b.zip)).toEqual(["SKILL.md", "scripts/run.py"]);
    expect(names(b.packageZip ?? new Uint8Array())).toEqual([
      "SKILL.md",
      "evals/cases.yaml",
      "kobe.skill.yaml",
      "scripts/run.py",
    ]);
    expect(sha256Hex(b.zip)).toBe(runtimeHash(asMap(files)));
    expect(b.packageHash).toBe(packageHash(asMap(files)));
    expect(b.packageHash).not.toBe(sha256Hex(b.zip));
    expect(b.fileCount).toBe(2);
    expect(b.manifest).toMatchObject({ version: "1.2.0", changelog: "Adds totals." });
  });

  it("has no separate package zip when the package is its runtime payload", () => {
    const result = validateZipBundle(zip({ "SKILL.md": SKILL_MD }));
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.packageZip).toBeNull();
    expect(result.value.packageHash).toBe(sha256Hex(result.value.zip));
    expect(result.value.manifest).toBeNull();
  });

  it("refuses a kobe.skill.yaml that is invalid or names another skill", () => {
    expect(failure({ "kobe.skill.yaml": "apiVersion: kobe.dev/skill/v9\n" }).code).toBe(
      "invalid_manifest",
    );
    expect(failure({ "kobe.skill.yaml": "name: [unclosed\n" }).code).toBe("invalid_manifest");
    expect(failure({ "kobe.skill.yaml": "a: 1\na: 2\n" }).code).toBe("invalid_manifest");
    const other = failure({
      "kobe.skill.yaml": MANIFEST.replace("name: demo-skill", "name: other"),
    });
    expect(other).toMatchObject({ code: "invalid_manifest" });
    expect(other.message).toMatch(/name/);
  });
});
