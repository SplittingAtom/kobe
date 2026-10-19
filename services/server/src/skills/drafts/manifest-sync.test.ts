import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { adviseBump } from "./bump.js";
import { manifestWithoutNumber, withSavedNumber } from "./manifest-sync.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined) => new TextDecoder().decode(b);
const MANIFEST = [
  "apiVersion: kobe.dev/skill/v1",
  "name: notes",
  "# the parent's number",
  "version: 2.3.0",
  "summary: Notes.",
  "changelog: Parent change.",
  "",
].join("\n");

/** KOBE-322: a draft's manifest takes the number and changelog of the version being saved. */
describe("withSavedNumber", () => {
  it("writes the saved number and changelog, keeping every other key and comment", () => {
    const out = withSavedNumber(new Map([["kobe.skill.yaml", enc(MANIFEST)]]), "0.1.0", "First.");
    const text = dec(out.get("kobe.skill.yaml"));
    expect(parse(text)).toEqual({
      apiVersion: "kobe.dev/skill/v1",
      name: "notes",
      version: "0.1.0",
      summary: "Notes.",
      changelog: "First.",
    });
    expect(text).toContain("# the parent's number");
  });

  it("leaves a draft without a manifest, or with one that doesn't parse, alone", () => {
    const none = new Map([["SKILL.md", enc("x")]]);
    expect([...withSavedNumber(none, "1.0.0", "x").keys()]).toEqual(["SKILL.md"]);
    const broken = enc("version: [");
    expect(
      withSavedNumber(new Map([["kobe.skill.yaml", broken]]), "1.0.0", "x").get("kobe.skill.yaml"),
    ).toBe(broken);
    expect(manifestWithoutNumber(broken)).toBeNull();
  });

  it("makes a manifest that differs only in its number no change for the bump", () => {
    const saved = withSavedNumber(new Map([["kobe.skill.yaml", enc(MANIFEST)]]), "2.4.0", "Next.");
    expect(adviseBump(saved, new Map([["kobe.skill.yaml", enc(MANIFEST)]]))).toEqual({
      kind: null,
      reasons: [],
    });
    const changed = new Map([["kobe.skill.yaml", enc(MANIFEST.replace("Notes.", "Other."))]]);
    expect(adviseBump(saved, changed).kind).toBe("patch");
  });
});
