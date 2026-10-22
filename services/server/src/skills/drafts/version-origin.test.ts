import { createHash } from "node:crypto";
import { canonicalZip } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { versionOrigin } from "./save.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("versionOrigin (KOBE-344 review)", () => {
  const files = new Map([["SKILL.md", enc("---\nname: a\ndescription: d\n---\n")]]);
  const filesSha256 = createHash("sha256").update(canonicalZip(files)).digest("hex");
  const origin = {
    kind: "git",
    url: "https://git.test/a",
    fetchedSha256: "f".repeat(64),
    filesSha256,
  };

  it("keeps the origin as is while the files are the imported ones", () => {
    expect(versionOrigin(origin, files)).toEqual(origin);
  });

  it("marks it modified once the files changed, keeping what was fetched", () => {
    const edited = new Map([...files, ["notes.md", enc("mine")]]);
    expect(versionOrigin(origin, edited)).toEqual({ ...origin, modified: true });
    const { filesSha256: _f, ...unknown } = origin;
    expect(versionOrigin(unknown, files)).toMatchObject({ modified: true });
    expect(versionOrigin(null, files)).toBeNull();
  });
});
