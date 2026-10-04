import { describe, expect, it } from "vitest";
import { strToU8, zipSync, type Zippable } from "fflate";
import { createHash } from "node:crypto";
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

  it("requires SKILL.md at the root or directly under one wrapper directory", () => {
    expect(failure(zip({ "other.md": strToU8("x") }))).toBe("skill_md_missing");
    expect(failure(zip({ "wrapper/deep/SKILL.md": strToU8(SKILL_MD) }))).toBe("skill_md_missing");
  });

  it("strips a single top-level wrapper directory and stores the normalized zip", () => {
    const wrapped = zip({
      "my-skill/SKILL.md": strToU8(SKILL_MD),
      "my-skill/scripts/run.py": strToU8("print(1)\n"),
    });
    const result = validateZipBundle(wrapped);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ name: "demo-skill", fileCount: 2 });
    // The stored bytes are a plain bundle (no wrapper) and validate on their own.
    expect(result.value.zip).not.toEqual(wrapped);
    const again = validateZipBundle(result.value.zip);
    expect(again.ok && again.value.zip).toEqual(result.value.zip);
    // Deterministic: the same files give the same bytes whatever the zip tool added.
    const other = validateZipBundle(
      zipSync({ "x/SKILL.md": strToU8(SKILL_MD), "x/scripts/run.py": strToU8("print(1)\n") }),
    );
    expect(other.ok && Buffer.from(other.value.zip).equals(Buffer.from(result.value.zip))).toBe(
      true,
    );
  });

  it("does not strip with two top-level directories or files beside the wrapper", () => {
    expect(failure(zip({ "a/SKILL.md": strToU8(SKILL_MD), "b/other.md": strToU8("x") }))).toBe(
      "skill_md_missing",
    );
    expect(failure(zip({ "a/SKILL.md": strToU8(SKILL_MD), "README.md": strToU8("x") }))).toBe(
      "skill_md_missing",
    );
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

const FILES = { "SKILL.md": strToU8(SKILL_MD), "scripts/run.py": strToU8("print(1)\n") };
const hashOf = (bytes: Uint8Array) => {
  const result = validateZipBundle(bytes);
  if (!result.ok) throw new Error(result.error.code);
  return createHash("sha256").update(result.value.zip).digest("hex");
};
const withComment = (bytes: Uint8Array, comment: string) => {
  const extra = strToU8(comment);
  const out = new Uint8Array(bytes.length + extra.length);
  out.set(bytes);
  out.set(extra, bytes.length);
  new DataView(out.buffer).setUint16(bytes.length - 2, extra.length, true);
  return out;
};

describe("canonical bundle (what is stored and hashed)", () => {
  const canonical = hashOf(zipSync(FILES, { level: 6, mtime: Date.UTC(1999, 1, 1) }));

  it("gives the same hash however the uploader's tool built the zip", () => {
    expect(hashOf(zipSync(FILES, { level: 0 }))).toBe(canonical);
    expect(hashOf(zipSync(FILES, { level: 9, mtime: Date.UTC(2024, 5, 5) }))).toBe(canonical);
    expect(
      hashOf(zipSync({ "scripts/run.py": FILES["scripts/run.py"], "SKILL.md": FILES["SKILL.md"] })),
    ).toBe(canonical);
    expect(hashOf(withComment(zipSync(FILES), "made by evil-zip 3000"))).toBe(canonical);
    const junk = new Uint8Array([...strToU8("MZ self-extractor stub"), ...zipSync(FILES)]);
    expect(hashOf(junk)).toBe(canonical);
    expect(
      hashOf(
        zipSync({
          "dir/SKILL.md": FILES["SKILL.md"],
          "dir/scripts/run.py": FILES["scripts/run.py"],
        }),
      ),
    ).toBe(canonical);
    expect(hashOf(zipSync({ ...FILES, "empty-dir/": new Uint8Array(0) }))).toBe(canonical);
  });

  it("ignores the local header's name and extra fields (only the central directory counts)", () => {
    const bytes = new Uint8Array(zipSync(FILES));
    // Same-length rename of the first local header's name: SKILL.md -> SKILL.xx
    const at = Buffer.from(bytes).indexOf(Buffer.from("SKILL.md"));
    bytes.set(strToU8("SKILL.xx"), at);
    expect(hashOf(bytes)).toBe(canonical);
  });

  it("writes plain entries: no extra fields, comments, attributes or directories", () => {
    const result = validateZipBundle(zipSync({ ...FILES, "d/": new Uint8Array(0) }));
    if (!result.ok) throw new Error(result.error.code);
    const view = new DataView(result.value.zip.buffer, result.value.zip.byteOffset);
    const eocd = result.value.zip.length - 22;
    expect(view.getUint16(eocd + 10, true)).toBe(2);
    expect(view.getUint16(eocd + 20, true)).toBe(0);
    let at = view.getUint32(eocd + 16, true);
    for (let i = 0; i < 2; i++) {
      expect(view.getUint16(at + 10, true)).toBe(0); // stored
      expect(view.getUint16(at + 30, true)).toBe(0); // extra
      expect(view.getUint16(at + 32, true)).toBe(0); // comment
      expect(view.getUint32(at + 38, true)).toBe(0); // attributes
      at += 46 + view.getUint16(at + 28, true);
    }
  });

  it("normalizes Unicode paths to NFC and rejects names that collide after it", () => {
    const nfc = "caf\u00e9.md";
    const nfd = "cafe\u0301.md";
    const a = hashOf(zipSync({ ...FILES, [nfc]: strToU8("x") }));
    expect(hashOf(zipSync({ ...FILES, [nfd]: strToU8("x") }))).toBe(a);
    expect(failure(zipSync({ ...FILES, [nfc]: strToU8("1"), [nfd]: strToU8("2") }))).toBe(
      "duplicate_path",
    );
    expect(failure(zipSync({ ...FILES, [nfc]: strToU8("1"), "CAF\u00c9.md": strToU8("2") }))).toBe(
      "duplicate_path",
    );
  });
});

describe("hostile archives", () => {
  it("aborts an entry that inflates far beyond its declared size", () => {
    const huge = zipSync({
      "SKILL.md": strToU8(SKILL_MD),
      "big.bin": new Uint8Array(60 * 1024 * 1024),
    });
    // Make the header claim 100 KB while ~60 MB of zeros come out.
    const view = new DataView(huge.buffer);
    let eocd = huge.length - 22;
    while (view.getUint32(eocd, true) !== 0x06054b50) eocd--;
    let at = view.getUint32(eocd + 16, true);
    const count = view.getUint16(eocd + 10, true);
    for (let i = 0; i < count; i++) {
      const nameLen = view.getUint16(at + 28, true);
      const name = new TextDecoder().decode(huge.subarray(at + 46, at + 46 + nameLen));
      if (name === "big.bin") view.setUint32(at + 24, 100_000, true);
      at += 46 + nameLen + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    }
    expect(huge.length).toBeLessThan(120_000);
    expect(failure(huge)).toBe("invalid_zip");
  });

  it("enforces the bundle-wide uncompressed budget while inflating", () => {
    const two = zipSync({
      "SKILL.md": strToU8(SKILL_MD),
      "a.txt": strToU8("a".repeat(900)),
      "b.txt": strToU8("b".repeat(900)),
    });
    expect(failure(two, { ...SKILL_LIMITS, maxUncompressedBytes: 1500 })).toBe("file_too_large");
  });

  it("rejects a compressed size larger than the declared size allows", () => {
    const bytes = patchCentral(zip({ "SKILL.md": strToU8(SKILL_MD + "x".repeat(2000)) }), 24, 100);
    expect(failure(bytes)).toBe("invalid_zip");
  });

  it.each([
    ["symlink", 0o120777],
    ["fifo", 0o010644],
    ["character device", 0o020644],
    ["socket", 0o140644],
  ])("rejects a %s whichever OS the archive claims", (_n, mode) => {
    for (const os of [0, 3, 19]) {
      const bytes = zip({
        "SKILL.md": strToU8(SKILL_MD),
        odd: [strToU8("x"), { os, attrs: mode << 16 }],
      });
      expect(failure(bytes)).toBe("symlink_not_allowed");
    }
  });

  it("accepts regular files with ordinary unix modes", () => {
    const bytes = zip({ "SKILL.md": [strToU8(SKILL_MD), { os: 3, attrs: 0o100644 << 16 }] });
    expect(validateZipBundle(bytes).ok).toBe(true);
  });

  it("caps frontmatter well below the database check", () => {
    const list = (n: number) => `[${Array.from({ length: n }, () => "1").join(",")}]`;
    const md = (n: number) => `---\nname: big\ndescription: d\nlist: ${list(n)}\n---\nx`;
    expect(validateZipBundle(zip({ "SKILL.md": strToU8(md(8000)) })).ok).toBe(true);
    expect(failure(zip({ "SKILL.md": strToU8(md(9000)) }))).toBe("invalid_skill_md");
  });
});
