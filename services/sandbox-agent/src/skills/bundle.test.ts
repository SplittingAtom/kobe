import { describe, expect, it } from "vitest";
import { BundleError, BUNDLE_LIMITS, readBundle } from "./bundle.js";
import {
  SERVER_CANONICAL_ZIP_BASE64,
  goodBundle,
  testZip,
  type TestEntry,
} from "../testing/zip.js";

const reason = (zip: Uint8Array, limits = BUNDLE_LIMITS): string => {
  try {
    readBundle(zip, limits);
  } catch (error) {
    if (error instanceof BundleError) return error.reason;
    throw error;
  }
  return "accepted";
};
const withEntry = (e: TestEntry) => testZip([{ name: "SKILL.md", data: "x" }, e]);

describe("readBundle", () => {
  it("reads a canonical zip made by the server's packer", () => {
    const files = readBundle(Buffer.from(SERVER_CANONICAL_ZIP_BASE64, "base64"));
    expect(files.map((f) => f.path).sort()).toEqual([
      "SKILL.md",
      "références/é.md",
      "scripts/run.sh",
    ]);
    expect(Buffer.from(files.find((f) => f.path === "scripts/run.sh")?.data ?? []).toString()).toBe(
      "echo hi\n",
    );
  });

  it("reads files in order with their content", () => {
    const files = readBundle(goodBundle());
    expect(files.map((f) => f.path)).toEqual(["SKILL.md", "scripts/run.sh"]);
  });

  it.each([
    ["a parent traversal", "../evil"],
    ["a nested traversal", "a/../../evil"],
    ["an absolute path", "/etc/passwd"],
    ["a drive letter", "C:/x"],
    ["a backslash", "a\\b"],
    ["a dot segment", "./a"],
    ["an empty segment", "a//b"],
    ["a control character", "a\u0001b"],
    ["a NUL byte", "a\u0000b"],
    ["a __proto__ segment", "x/__proto__/y"],
    ["a directory entry", "dir/"],
    ["a non-NFC name", "e\u0301.md"],
  ])("refuses %s", (_label, name) => {
    expect(reason(withEntry({ name, data: "x" }))).toBe("unsafe_path");
  });

  it("refuses a path longer than the cap", () => {
    expect(reason(withEntry({ name: "a".repeat(241), data: "x" }))).toBe("unsafe_path");
  });

  it.each([
    ["a symlink", 0o120777],
    ["a character device", 0o020666],
    ["a fifo", 0o010644],
    ["a socket", 0o140755],
    ["a directory type", 0o040755],
  ])("refuses %s", (_label, mode) => {
    expect(reason(withEntry({ name: "x", data: "t", mode }))).toBe("special_file");
  });

  it("accepts a regular-file mode", () => {
    expect(reason(withEntry({ name: "x", data: "t", mode: 0o100644 }))).toBe("accepted");
  });

  it("refuses compression, encryption and data descriptors: the canonical form is stored plain", () => {
    expect(reason(withEntry({ name: "x", data: "t", method: 8 }))).toBe("not_canonical");
    expect(reason(withEntry({ name: "x", data: "t", flags: 1 }))).toBe("not_canonical");
    expect(reason(withEntry({ name: "x", data: "t", flags: 8 }))).toBe("not_canonical");
  });

  it("refuses a checksum that does not match", () => {
    expect(reason(withEntry({ name: "x", data: "t", crc: 123 }))).toBe("bad_checksum");
  });

  it("refuses duplicate paths, also by case, and a file under a file", () => {
    expect(
      reason(
        testZip([
          { name: "SKILL.md", data: "a" },
          { name: "SKILL.md", data: "b" },
        ]),
      ),
    ).toBe("duplicate_path");
    expect(
      reason(
        testZip([
          { name: "SKILL.md", data: "a" },
          { name: "skill.MD", data: "b" },
        ]),
      ),
    ).toBe("duplicate_path");
    expect(
      reason(
        testZip([
          { name: "SKILL.md", data: "a" },
          { name: "a", data: "b" },
          { name: "a/b", data: "c" },
        ]),
      ),
    ).toBe("duplicate_path");
  });

  it("refuses a bundle without SKILL.md at the root", () => {
    expect(reason(testZip([{ name: "docs/SKILL.md", data: "x" }]))).toBe("no_skill_md");
    expect(reason(testZip([{ name: "skill.md", data: "x" }]))).toBe("no_skill_md");
    expect(reason(testZip([]))).toBe("no_skill_md");
  });

  it("enforces the file count, per-file, SKILL.md and total size caps", () => {
    const limits = {
      ...BUNDLE_LIMITS,
      maxFiles: 2,
      maxFileBytes: 10,
      maxTotalBytes: 15,
      maxSkillMdBytes: 5,
    };
    expect(
      reason(
        testZip([
          { name: "SKILL.md", data: "x" },
          { name: "a", data: "x" },
          { name: "b", data: "x" },
        ]),
        limits,
      ),
    ).toBe("too_many_files");
    expect(
      reason(
        testZip([
          { name: "SKILL.md", data: "x" },
          { name: "a", data: "x".repeat(11) },
        ]),
        limits,
      ),
    ).toBe("too_large");
    expect(reason(testZip([{ name: "SKILL.md", data: "x".repeat(6) }]), limits)).toBe("too_large");
    expect(
      reason(
        testZip([
          { name: "SKILL.md", data: "x".repeat(5) },
          { name: "a", data: "x".repeat(10) },
          { name: "b", data: "x" },
        ]),
        { ...limits, maxFiles: 5 },
      ),
    ).toBe("too_large");
  });

  it("refuses junk before or after the archive and a zip comment", () => {
    expect(
      reason(testZip([{ name: "SKILL.md", data: "x" }], { junkBefore: Buffer.from("MZ junk") })),
    ).toBe("not_canonical");
    expect(reason(testZip([{ name: "SKILL.md", data: "x" }], { comment: "hi" }))).toBe(
      "not_canonical",
    );
    expect(reason(Buffer.concat([goodBundle(), Buffer.from("tail")]))).toBe("not_canonical");
  });

  it("refuses things that are not zips, or are cut short", () => {
    expect(reason(Buffer.from("not a zip at all, definitely"))).toBe("not_canonical");
    expect(reason(Buffer.alloc(3))).toBe("bad_zip");
    const good = goodBundle();
    expect(reason(good.subarray(0, good.length - 30))).not.toBe("accepted");
  });

  it("refuses a local header that names another file than the central directory", () => {
    const zip = Buffer.from(goodBundle());
    const at = zip.indexOf("scripts/run.sh");
    zip.write("scripts/xxx.sh", at); // local copy only: the central name stays
    expect(reason(zip)).toBe("bad_zip");
  });
});
