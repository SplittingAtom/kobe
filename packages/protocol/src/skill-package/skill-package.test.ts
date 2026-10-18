import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { packageHash, runtimeHash, runtimeZip, skillPackageHashes } from "../node/index.js";
import { SKILL_HASH_VECTORS } from "../testing/skill-hash-vectors.js";
import {
  canonicalOrder,
  canonicalZip,
  checkPackagePaths,
  crc32,
  hashedPackageFiles,
  kobeSkillManifestSchema,
  MANIFEST_MAX_BYTES,
  MANIFEST_YAML_OPTIONS,
  manifestMismatches,
  packageFileRole,
  packagePathProblem,
  provenanceMismatches,
  SkillPackageError,
  provenanceSchema,
  runtimeFiles,
} from "./index.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const fixtures = (dir: string) =>
  readdirSync(join(FIXTURES, dir))
    .sort()
    .map((f) => ({ file: f, text: readFileSync(join(FIXTURES, dir, f), "utf8") }));
const utf8 = (s: string) => new TextEncoder().encode(s);

describe("package layout (KOBE-309)", () => {
  it("gives each root name its role; only the root names are reserved", () => {
    expect(packageFileRole("SKILL.md")).toBe("runtime");
    expect(packageFileRole("scripts/build.py")).toBe("runtime");
    expect(packageFileRole("scripts/evals/x")).toBe("runtime");
    expect(packageFileRole("references/kobe.skill.yaml")).toBe("runtime");
    expect(packageFileRole("evals/cases.yaml")).toBe("evals");
    expect(packageFileRole("evals/fixtures/a.csv")).toBe("evals");
    expect(packageFileRole("kobe.skill.yaml")).toBe("manifest");
    expect(packageFileRole("provenance.json")).toBe("provenance");
  });

  it("splits a package into the runtime payload and the hashed package", () => {
    const files = new Map(
      ["SKILL.md", "evals/cases.yaml", "kobe.skill.yaml", "provenance.json", "assets/a"].map(
        (p) => [p, utf8(p)] as const,
      ),
    );
    expect([...runtimeFiles(files).keys()]).toEqual(["SKILL.md", "assets/a"]);
    expect([...hashedPackageFiles(files).keys()]).toEqual([
      "SKILL.md",
      "evals/cases.yaml",
      "kobe.skill.yaml",
      "assets/a",
    ]);
  });

  it("refuses unsafe, non-NFC and colliding paths, a file named evals, and a missing SKILL.md", () => {
    expect(packagePathProblem("scripts/run.py")).toBeNull();
    expect(packagePathProblem("")).toBe("empty");
    expect(packagePathProblem("a".repeat(241))).toBe("too_long");
    expect(packagePathProblem("e\u0301.md")).toBe("not_nfc");
    expect(packagePathProblem("/etc/passwd")).toBe("absolute");
    expect(packagePathProblem("C:/x")).toBe("absolute");
    expect(packagePathProblem("a\\b")).toBe("control_or_backslash");
    expect(packagePathProblem("a\nb")).toBe("control_or_backslash");
    for (const bad of ["a/../b", "./a", "a//b", "a/", "__proto__/x"])
      expect(packagePathProblem(bad), bad).toBe("bad_segment");
    expect(checkPackagePaths(["SKILL.md", "Notes.md", "notes.md", "evals"])).toEqual([
      { path: "notes.md", problem: "duplicate" },
      { path: "evals", problem: "reserved_directory" },
    ]);
    expect(checkPackagePaths(["scripts/x"])).toEqual([
      { path: "SKILL.md", problem: "skill_md_missing" },
    ]);
  });

  it("refuses lone surrogates: two of them would encode to one zip name and one hash", () => {
    expect(packagePathProblem("x\uD800.md")).toBe("not_well_formed");
    expect(packagePathProblem("x\uDBFF.md")).toBe("not_well_formed");
    expect(packagePathProblem("x\uDC00")).toBe("not_well_formed");
    expect(packagePathProblem("\u{1F600}.md")).toBeNull();
    const twins = new Map([
      ["SKILL.md", utf8("x")],
      ["x\uD800.md", utf8("a")],
      ["x\uDBFF.md", utf8("b")],
    ]);
    expect(() => runtimeHash(twins)).toThrow(SkillPackageError);
  });

  it("refuses invisible and bidi controls that spoof a path in review", () => {
    for (const bad of ["scripts/run\u202egnp.sh", "a\u200bb", "a\u0085b", "\ufeffx", "a\u2066b"])
      expect(packagePathProblem(bad), JSON.stringify(bad)).toBe("invisible_or_bidi");
  });

  it("refuses a path that is both a file and a directory, case-folded", () => {
    expect(checkPackagePaths(["SKILL.md", "scripts", "scripts/x.py"])).toEqual([
      { path: "scripts", problem: "file_and_directory" },
      { path: "scripts/x.py", problem: "file_and_directory" },
    ]);
    expect(checkPackagePaths(["SKILL.md", "Docs", "docs/a/b"]).map((p) => p.problem)).toEqual([
      "file_and_directory",
      "file_and_directory",
    ]);
    expect(checkPackagePaths(["SKILL.md", "docs/a", "docs/b"])).toEqual([]);
  });

  it("refuses case variants of the reserved root names instead of shipping them as payload", () => {
    for (const path of [
      "Evals/cases.yaml",
      "EVALS",
      "KOBE.SKILL.YAML",
      "Provenance.json",
      "skill.md",
    ])
      expect(checkPackagePaths(["SKILL.md", path], { kobeProvenance: true }), path).toContainEqual({
        path,
        problem: "reserved_name_case",
      });
    expect(
      checkPackagePaths(["SKILL.md", "scripts/Evals/x", "references/KOBE.SKILL.YAML"]),
    ).toEqual([]);
    expect(checkPackagePaths(["SKILL.md", "aς", "aσ"]).map((p) => p.problem)).toEqual([
      "duplicate",
    ]);
  });

  it("refuses an authored provenance.json; only a package Kobe assembled may carry one", () => {
    expect(checkPackagePaths(["SKILL.md", "provenance.json"])).toEqual([
      { path: "provenance.json", problem: "provenance_not_allowed" },
    ]);
    expect(checkPackagePaths(["SKILL.md", "provenance.json"], { kobeProvenance: true })).toEqual(
      [],
    );
    const files = new Map([
      ["SKILL.md", utf8("x")],
      ["provenance.json", utf8("{}")],
    ]);
    expect(() => runtimeHash(files)).toThrow(/provenance_not_allowed/);
    expect(runtimeHash(files, { kobeProvenance: true })).toBe(
      runtimeHash(new Map([["SKILL.md", utf8("x")]])),
    );
  });

  it("never hashes or zips an unchecked package", () => {
    const unsafe = new Map([
      ["SKILL.md", utf8("x")],
      ["../../etc/x", utf8("y")],
    ]);
    expect(() => runtimeHash(unsafe)).toThrow(SkillPackageError);
    expect(() => packageHash(unsafe)).toThrow(SkillPackageError);
    expect(() => canonicalZip(unsafe)).toThrow(SkillPackageError);
    expect(() => canonicalZip(new Map([["a", utf8("x")]]))).toThrow(/skill_md_missing/);
    expect(() =>
      canonicalZip(
        new Map([
          ["SKILL.md", utf8("x")],
          ["provenance.json", utf8("{}")],
        ]),
      ),
    ).toThrow(/provenance_not_allowed/);
  });
});

describe("canonical zip (KOBE-309)", () => {
  it("orders array-index names first (numerically), then by UTF-16 code units", () => {
    expect(canonicalOrder(["b", "10", "SKILL.md", "9", "a/1", "B", "é", "😀", "01"])).toEqual([
      "9",
      "10",
      "01",
      "B",
      "SKILL.md",
      "a/1",
      "b",
      "é",
      "😀",
    ]);
  });

  it("computes the zip CRC-32", () => {
    expect(crc32(utf8(""))).toBe(0);
    expect(crc32(utf8("123456789"))).toBe(0xcbf43926);
  });

  it("writes stored entries with the fixed DOS time, UTF-8 flags and no extras", () => {
    // Entries: SKILL.md (ASCII name, 2 bytes), then é (UTF-8 name).
    const zip = canonicalZip(
      new Map([
        ["é", utf8("x")],
        ["SKILL.md", utf8("hi")],
      ]),
    );
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(4, true)).toBe(20); // version needed
    expect(view.getUint16(6, true)).toBe(0); // ASCII name
    expect(view.getUint16(8, true)).toBe(0); // stored
    expect(view.getUint16(10, true)).toBe(0x6000); // 12:00:00
    expect(view.getUint16(12, true)).toBe(0x5021); // 2020-01-01
    expect(view.getUint16(26, true)).toBe(8); // "SKILL.md"
    expect(view.getUint16(28, true)).toBe(0); // no extra field
    const second = 30 + 8 + 2;
    expect(view.getUint32(second, true)).toBe(0x04034b50);
    expect(view.getUint16(second + 6, true)).toBe(0x0800); // UTF-8 name
    const end = zip.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(2);
    expect(view.getUint16(end + 20, true)).toBe(0); // no comment
  });

  it("orders by UTF-16 code units, not code points or UTF-8 bytes", () => {
    // U+FF5E is one UTF-16 unit (0xFF5E); U+1F600 starts with 0xD83D, so it sorts first here,
    // though its code point and UTF-8 bytes are larger. Pinned by the last golden vector.
    expect(canonicalOrder(["\uff5e.txt", "\u{1F600}.txt"])).toEqual([
      "\u{1F600}.txt",
      "\uff5e.txt",
    ]);
    expect(canonicalOrder(["4294967295", "4294967294", "-1", "01", "0"])).toEqual([
      "0",
      "4294967294",
      "-1",
      "01",
      "4294967295",
    ]);
  });
});

describe("golden hash vectors (KOBE-309 ac-3)", () => {
  for (const v of SKILL_HASH_VECTORS) {
    it(v.name, () => {
      expect(checkPackagePaths(v.files.keys(), v.options)).toEqual([]);
      expect(skillPackageHashes(v.files, v.options)).toEqual({
        runtimeHash: v.runtimeHash,
        packageHash: v.packageHash,
      });
    });
  }

  it("equals the package hash for a package with no evals/ and no kobe.skill.yaml", () => {
    const files = new Map([
      ["SKILL.md", utf8("x")],
      ["provenance.json", utf8("{}")],
    ]);
    expect(packageHash(files, { kobeProvenance: true })).toBe(
      runtimeHash(files, { kobeProvenance: true }),
    );
    expect(runtimeZip(files, { kobeProvenance: true })).toEqual(
      canonicalZip(new Map([["SKILL.md", utf8("x")]])),
    );
  });

  it("does not depend on the order files are given in", () => {
    const v = SKILL_HASH_VECTORS[4];
    if (!v) throw new Error("vector missing");
    const reversed = new Map([...v.files].reverse());
    expect(skillPackageHashes(reversed).runtimeHash).toBe(v.runtimeHash);
  });
});

/** Parses a manifest fixture by the contract's text rules. */
function parseManifestText(text: string): unknown {
  if (new TextEncoder().encode(text).length > MANIFEST_MAX_BYTES) throw new Error("too large");
  const value: unknown = parse(text, MANIFEST_YAML_OPTIONS);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("the root must be a mapping");
  return value;
}

/** Where each invalid fixture must fail: the issue's path, or `(root)` for an unknown key. */
const MANIFEST_REFUSALS: Record<string, string> = {
  "invalid-api-version.yaml": "apiVersion",
  "invalid-duplicate-tag.yaml": "tags",
  "invalid-empty-summary.yaml": "summary",
  "invalid-maintainer.yaml": "maintainers.0",
  "invalid-name.yaml": "name",
  "invalid-number-version.yaml": "version",
  "invalid-semver.yaml": "version",
  "invalid-unknown-key.yaml": "(root)",
  "invalid-wildcard-egress.yaml": "capabilities.egress.0",
};
const PROVENANCE_REFUSALS: Record<string, string> = {
  "invalid-api-version.json": "apiVersion",
  "invalid-finding-excerpt.json": "scan.findings.0",
  "invalid-hash.json": "hashes.runtime",
  "invalid-instant-date.json": "createdAt",
  "invalid-origin-userinfo.json": "origin.url",
  "invalid-origin-query.json": "origin.url",
  "invalid-origin-fragment.json": "origin.url",
  "invalid-finding-path.json": "scan.findings.0.file",
  "invalid-instant.json": "createdAt",
  "invalid-origin-http.json": "origin.url",
  "invalid-ratio.json": "scorecard.passRateWith",
  "invalid-scorecard-transcript.json": "scorecard",
};
const issueAt = (i: { path: PropertyKey[] }) =>
  i.path.length === 0 ? "(root)" : i.path.map(String).join(".");

describe("kobe.skill.yaml (KOBE-309 ac-1)", () => {
  const all = fixtures("manifest");

  it("has valid and invalid golden fixtures", () => {
    expect(all.filter((f) => f.file.startsWith("valid-")).length).toBeGreaterThanOrEqual(3);
    expect(all.filter((f) => !f.file.startsWith("valid-")).length).toBeGreaterThanOrEqual(10);
  });

  for (const { file, text } of all) {
    if (file.startsWith("valid-")) {
      it(`accepts ${file}`, () => {
        const parsed = kobeSkillManifestSchema.safeParse(parseManifestText(text));
        expect(parsed.error?.issues ?? []).toEqual([]);
      });
    } else if (file.startsWith("yaml-")) {
      it(`refuses ${file} by the text rules`, () => {
        expect(() => parseManifestText(text)).toThrow();
      });
    } else {
      it(`refuses ${file} by the schema, at ${MANIFEST_REFUSALS[file]}`, () => {
        const parsed = kobeSkillManifestSchema.safeParse(parseManifestText(text));
        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues.map(issueAt)).toEqual([MANIFEST_REFUSALS[file]]);
      });
    }
  }

  it("parses the spec's example into the expected value", () => {
    const text = all.find((f) => f.file === "valid-full.yaml")?.text ?? "";
    expect(kobeSkillManifestSchema.parse(parseManifestText(text))).toEqual({
      apiVersion: "kobe.dev/skill/v1",
      name: "quarterly-report",
      version: "1.3.0",
      summary: "Builds the quarterly revenue workbook from a sales export.",
      tags: ["finance", "documents"],
      license: "Apache-2.0",
      maintainers: [
        "user:7f3c2a10-1b2c-4d5e-8f90-0a1b2c3d4e5f",
        "user:a19d0000-0000-4000-8000-000000000001",
      ],
      capabilities: {
        egress: ["pypi.org", "files.pythonhosted.org"],
        packages: { pip: ["openpyxl==3.1.*"] },
      },
      compatibility: { kobe: ">=1.2", pi: "1.0.x" },
      changelog: "Adds a totals row per region.",
    });
  });

  it("must name the SKILL.md name and the saved semver", () => {
    const m = kobeSkillManifestSchema.parse({
      apiVersion: "kobe.dev/skill/v1",
      name: "notes",
      version: "1.0.0",
      summary: "S.",
    });
    expect(manifestMismatches(m, { name: "notes", semver: "1.0.0" })).toEqual([]);
    expect(manifestMismatches(m, { name: "other", semver: "1.1.0" })).toEqual(["name", "version"]);
  });
});

describe("provenance.json (KOBE-309 ac-1)", () => {
  const all = fixtures("provenance");

  for (const { file, text } of all) {
    const valid = file.startsWith("valid-");
    it(`${valid ? "accepts" : "refuses"} ${file}`, () => {
      const parsed = provenanceSchema.safeParse(JSON.parse(text));
      if (valid) expect(parsed.error?.issues ?? []).toEqual([]);
      else expect(parsed.error?.issues.map(issueAt)).toEqual([PROVENANCE_REFUSALS[file]]);
    });
  }

  it("checks the hashes, the name and the version against the package, and the scorecard's freshness", () => {
    const text = all.find((f) => f.file === "valid-full.json")?.text ?? "{}";
    const p = provenanceSchema.parse(JSON.parse(text));
    const actual = {
      name: "quarterly-report",
      semver: "1.3.0",
      runtimeHash: "1".repeat(64),
      packageHash: "2".repeat(64),
    };
    expect(provenanceMismatches(p, actual)).toEqual([]);
    expect(provenanceMismatches(p, { ...actual, packageHash: "4".repeat(64) })).toEqual([
      "package_hash",
      "scorecard",
    ]);
    expect(provenanceMismatches(p, { ...actual, runtimeHash: "4".repeat(64) })).toEqual([
      "runtime_hash",
    ]);
  });
});
