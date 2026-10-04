import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildZip, composeSkillMd, decodeBundle, splitSkillMd } from "./bundle";
import { SKILL_LIMITS } from "./limits";

const md = "---\nname: demo\ndescription: A demo\nlicense: MIT\n---\n# Demo\nBody\n";

describe("splitSkillMd / composeSkillMd", () => {
  it("splits frontmatter into name, description and the other keys", () => {
    const parts = splitSkillMd(md);
    expect(parts).toEqual({
      ok: true,
      value: {
        name: "demo",
        description: "A demo",
        other: "license: MIT\n",
        body: "# Demo\nBody\n",
      },
    });
  });

  it("round-trips through compose", () => {
    const parts = splitSkillMd(md);
    if (!parts.ok) throw new Error(parts.error);
    expect(splitSkillMd(composeSkillMd(parts.value))).toEqual(parts);
  });

  it("refuses text without frontmatter", () => {
    expect(splitSkillMd("# no frontmatter").ok).toBe(false);
  });
});

describe("decodeBundle", () => {
  it("separates text files from binaries kept as is", () => {
    const png = new Uint8Array([0x89, 0x50, 0, 1, 2, 0xff]);
    const zip = zipSync({
      "SKILL.md": strToU8(md),
      "notes/a.txt": strToU8("hello"),
      "img/logo.png": png,
    });
    const res = decodeBundle(zip);
    if (!res.ok) throw new Error(res.error);
    expect(res.value.skillMd).toBe(md);
    expect(res.value.text).toEqual([{ path: "notes/a.txt", text: "hello" }]);
    expect(res.value.kept).toEqual([{ path: "img/logo.png", bytes: png }]);
  });

  it("refuses a bundle with too many files or a missing SKILL.md", () => {
    const many = Object.fromEntries(
      Array.from({ length: SKILL_LIMITS.maxFiles + 1 }, (_, i) => [`f${i}.txt`, strToU8("x")]),
    );
    expect(decodeBundle(zipSync({ "SKILL.md": strToU8(md), ...many })).ok).toBe(false);
    expect(decodeBundle(zipSync({ "a.txt": strToU8("x") })).ok).toBe(false);
  });

  it("refuses declared sizes above the caps before inflating", () => {
    const big = new Uint8Array(SKILL_LIMITS.maxFileBytes + 1);
    const res = decodeBundle(zipSync({ "SKILL.md": strToU8(md), "big.bin": big }));
    expect(res.ok).toBe(false);
  });
});

describe("buildZip", () => {
  it("packs text and kept binaries and decodes back", () => {
    const kept = [{ path: "b.bin", bytes: new Uint8Array([0, 255, 0]) }];
    const zip = buildZip(md, [{ path: "x/y.txt", text: "é" }], kept);
    const res = decodeBundle(zip);
    if (!res.ok) throw new Error(res.error);
    expect(res.value.text).toEqual([{ path: "x/y.txt", text: "é" }]);
    expect(res.value.kept).toEqual(kept);
  });
});
