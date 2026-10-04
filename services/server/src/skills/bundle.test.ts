import { describe, expect, it } from "vitest";
import { strToU8, zipSync, type Zippable } from "fflate";
import { bundleFromSkillMd, validateZipBundle } from "./bundle.js";
import { SKILL_LIMITS } from "./limits.js";

const SKILL_MD = "---\nname: demo-skill\ndescription: Does demo things\n---\n# Demo\nBody.\n";
const zip = (files: Zippable) => zipSync(files, { level: 6 });
const good = () => zip({ "SKILL.md": strToU8(SKILL_MD), "scripts/run.py": strToU8("print(1)\n") });

function failure(bytes: Uint8Array, limits = SKILL_LIMITS) {
  const result = validateZipBundle(bytes, limits);
  if (result.ok) throw new Error("expected a validation error");
  return result.error.code;
}

/** Overwrites a u32 in the first central-directory record, to make a header lie. */
function patchCentral(bytes: Uint8Array, offsetInRecord: number, value: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  const view = new DataView(copy.buffer);
  for (let at = copy.length - 22; at >= 0; at--) {
    if (view.getUint32(at, true) === 0x06054b50) {
      view.setUint32(view.getUint32(at + 16, true) + offsetInRecord, value, true);
      return copy;
    }
  }
  throw new Error("no EOCD");
}

describe("validateZipBundle", () => {
  it("accepts a bundle and reports its metadata", () => {
    const result = validateZipBundle(good());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      name: "demo-skill",
      description: "Does demo things",
      fileCount: 2,
    });
    expect(result.value.frontmatter).toEqual({
      name: "demo-skill",
      description: "Does demo things",
    });
  });

  it("requires SKILL.md at the root", () => {
    expect(failure(zip({ "other.md": strToU8("x") }))).toBe("skill_md_missing");
    expect(failure(zip({ "wrapper/SKILL.md": strToU8(SKILL_MD) }))).toBe("skill_md_missing");
  });

  it.each([
    ["no frontmatter", "# just text"],
    ["unterminated frontmatter", "---\nname: a\ndescription: b\n"],
    ["missing name", "---\ndescription: b\n---\nx"],
    ["missing description", "---\nname: a\n---\nx"],
    ["blank description", "---\nname: a\ndescription: '  '\n---\nx"],
    ["uppercase name", "---\nname: Demo\ndescription: b\n---\nx"],
    ["path-like name", "---\nname: ../x\ndescription: b\n---\nx"],
    ["non-string name", "---\nname: 12\ndescription: b\n---\nx"],
    ["invalid YAML", "---\nname: [\ndescription: b\n---\nx"],
    ["list frontmatter", "---\n- a\n---\nx"],
  ])("rejects SKILL.md with %s", (_label, text) => {
    expect(failure(zip({ "SKILL.md": strToU8(text) }))).toBe("invalid_skill_md");
  });

  it.each([
    "../evil.txt",
    "a/../../evil.txt",
    "/abs.txt",
    "C:/win.txt",
    "a\\b.txt",
    "a//b.txt",
    "./x",
  ])("rejects the unsafe path %s", (name) => {
    expect(failure(zip({ "SKILL.md": strToU8(SKILL_MD), [name]: strToU8("x") }))).toBe(
      "unsafe_path",
    );
  });

  it("rejects symlinks", () => {
    const bytes = zip({
      "SKILL.md": strToU8(SKILL_MD),
      link: [strToU8("/etc/passwd"), { os: 3, attrs: 0o120777 << 16 }],
    });
    expect(failure(bytes)).toBe("symlink_not_allowed");
  });

  it("rejects paths that differ only by case", () => {
    const bytes = zip({
      "SKILL.md": strToU8(SKILL_MD),
      "a.txt": strToU8("1"),
      "A.txt": strToU8("2"),
    });
    expect(failure(bytes)).toBe("duplicate_path");
  });

  it("caps the upload size, file count, file size and total size", () => {
    expect(failure(good(), { ...SKILL_LIMITS, maxBundleBytes: 10 })).toBe("bundle_too_large");
    expect(failure(good(), { ...SKILL_LIMITS, maxFiles: 1 })).toBe("too_many_files");
    expect(failure(good(), { ...SKILL_LIMITS, maxFileBytes: 20 })).toBe("file_too_large");
    expect(failure(good(), { ...SKILL_LIMITS, maxUncompressedBytes: 40 })).toBe("file_too_large");
  });

  it("rejects a zip bomb by ratio", () => {
    const bomb = zip({
      "SKILL.md": strToU8(SKILL_MD),
      "zeros.bin": new Uint8Array(4 * 1024 * 1024),
    });
    expect(bomb.length).toBeLessThan(10_000);
    expect(failure(bomb)).toBe("bundle_too_expansive");
  });

  it("rejects an entry that inflates beyond its declared size", () => {
    const lying = patchCentral(zip({ "SKILL.md": strToU8(SKILL_MD + "x".repeat(5000)) }), 24, 10);
    expect(failure(lying)).toBe("invalid_zip");
  });

  it("rejects garbage, truncated and empty archives", () => {
    expect(failure(strToU8("not a zip"))).toBe("invalid_zip");
    expect(failure(good().subarray(0, 60))).toBe("invalid_zip");
    expect(failure(new Uint8Array(0))).toBe("invalid_zip");
  });

  it("rejects encrypted entries", () => {
    const bytes = new Uint8Array(good());
    const view = new DataView(bytes.buffer);
    for (let at = bytes.length - 22; at >= 0; at--) {
      if (view.getUint32(at, true) === 0x06054b50) {
        const central = view.getUint32(at + 16, true);
        view.setUint16(central + 8, 1, true);
        break;
      }
    }
    expect(failure(bytes)).toBe("invalid_zip");
  });
});

describe("bundleFromSkillMd", () => {
  it("wraps a SKILL.md into a deterministic one-file bundle that validates", () => {
    const first = bundleFromSkillMd(strToU8(SKILL_MD));
    const second = bundleFromSkillMd(strToU8(SKILL_MD));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(Buffer.from(first.value.zip).equals(Buffer.from(second.value.zip))).toBe(true);
    expect(first.value).toMatchObject({ name: "demo-skill", fileCount: 1 });
    expect(validateZipBundle(first.value.zip).ok).toBe(true);
  });

  it("rejects an invalid or oversized SKILL.md", () => {
    const invalid = bundleFromSkillMd(strToU8("no frontmatter"));
    expect(invalid.ok ? "ok" : invalid.error.code).toBe("invalid_skill_md");
    const big = bundleFromSkillMd(strToU8(SKILL_MD + "x".repeat(SKILL_LIMITS.maxSkillMdBytes)));
    expect(big.ok ? "ok" : big.error.code).toBe("file_too_large");
  });

  it("rejects bytes that are not UTF-8", () => {
    const result = bundleFromSkillMd(new Uint8Array([0x2d, 0x2d, 0x2d, 0xff, 0xfe]));
    expect(result.ok ? "ok" : result.error.code).toBe("invalid_skill_md");
  });
});
