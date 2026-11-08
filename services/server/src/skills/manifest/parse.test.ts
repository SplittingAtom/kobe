import { MANIFEST_MAX_BYTES, kobeSkillManifestSchema } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { readManifest } from "../bundle.js";
import {
  cleanEgress,
  cleanPackages,
  cleanSummary,
  cleanTags,
  jsonObjectIn,
  manifestFromReply,
  manifestFromSeed,
  manifestYaml,
} from "./parse.js";

/** KOBE-564 ac-3: a model's reply becomes a manifest the package contract accepts, or the seed. */
const SEED = {
  name: "sales-report",
  semver: "1.2.0",
  description:
    "Builds the quarterly sales report from the warehouse. Use when asked for sales figures.",
  license: "Apache-2.0",
};

describe("manifestFromReply", () => {
  it("takes summary, tags and capabilities from the reply; name, version and license are the seed's", () => {
    const reply = JSON.stringify({
      name: "evil-rename",
      version: "9.9.9",
      apiVersion: "kobe.dev/skill/v2",
      license: "WTFPL",
      maintainers: ["user:00000000-0000-4000-8000-000000000000"],
      summary: "  Builds quarterly sales reports\nfrom the warehouse.  ",
      tags: ["Sales", "reporting", "sales", "Not A Tag!", "x".repeat(40)],
      capabilities: {
        egress: [
          "https://api.example.com/v1/x",
          "WAREHOUSE.internal:5432",
          "*.bad.io",
          "api.example.com",
        ],
        packages: {
          pip: ["pandas>=2", "open pyxl", "pandas>=2"],
          npm: ["left-pad@^1"],
          cargo: ["x"],
        },
      },
      compatibility: { kobe: ">=1" },
      changelog: "whatever",
    });
    const { manifest, fromModel } = manifestFromReply(reply, SEED);
    expect(fromModel).toBe(true);
    expect(manifest).toEqual({
      apiVersion: "kobe.dev/skill/v1",
      name: "sales-report",
      version: "1.2.0",
      summary: "Builds quarterly sales reports from the warehouse.",
      tags: ["sales", "reporting"],
      license: "Apache-2.0",
      capabilities: {
        egress: ["api.example.com", "warehouse.internal"],
        packages: { pip: ["pandas>=2"], npm: ["left-pad@^1"] },
      },
    });
    expect(kobeSkillManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("reads the object out of prose or a fence, and falls back to SKILL.md's description otherwise", () => {
    const fenced = 'Here you go:\n```json\n{"summary": "Reports."}\n```\nAnything else?';
    expect(manifestFromReply(fenced, SEED).manifest.summary).toBe("Reports.");
    const prose = 'Sure. {"summary": "Reports.", "tags": ["sales"]} Done.';
    expect(manifestFromReply(prose, SEED).manifest.tags).toEqual(["sales"]);
    const none = manifestFromReply("I cannot help with that.", SEED);
    expect(none.fromModel).toBe(false);
    expect(none.manifest).toEqual(manifestFromSeed(SEED));
    expect(none.manifest.summary).toBe(SEED.description);
    expect(manifestFromReply("[1, 2]", SEED).fromModel).toBe(false);
  });

  it("without a license in the seed the manifest has none; an invalid one is dropped", () => {
    expect(manifestFromSeed({ ...SEED, license: undefined }).license).toBeUndefined();
    expect(manifestFromSeed({ ...SEED, license: "not;valid" }).license).toBeUndefined();
    expect(manifestFromSeed({ ...SEED, license: "Proprietary" }).license).toBe("Proprietary");
  });

  it("an empty or unusable summary in the reply keeps the seed's", () => {
    expect(manifestFromReply('{"summary": "   "}', SEED).manifest.summary).toBe(SEED.description);
    expect(manifestFromReply('{"summary": 42}', SEED).manifest.summary).toBe(SEED.description);
  });
});

describe("cleaners", () => {
  it("cleanSummary: one line, no control or format characters, cut at a word to 280", () => {
    expect(cleanSummary("a‮b​c\n\nd")).toBe("a b c d");
    const long = cleanSummary(`${"word ".repeat(70)}tail`);
    expect(long.length).toBeLessThanOrEqual(280);
    expect(long.endsWith("…")).toBe(true);
    expect(long).not.toContain("wor…");
    expect(cleanSummary("x".repeat(300)).length).toBe(280);
  });

  it("cleanTags: lowercase slugs only, unique, at most 10", () => {
    expect(cleanTags(["A", "a", "b-c", "-x", "d_e", 7, "ok9"])).toEqual(["a", "b-c", "ok9"]);
    expect(cleanTags(Array.from({ length: 20 }, (_, i) => `t${i}`))).toHaveLength(10);
    expect(cleanTags("sales")).toEqual([]);
  });

  it("cleanEgress: hosts from hosts, URLs or host:port; wildcards, IPs-with-paths and junk dropped", () => {
    expect(
      cleanEgress([
        "https://API.example.com/path?q=1",
        "db.internal:5432",
        "*.x.io",
        "localhost",
        "a b",
      ]),
    ).toEqual(["api.example.com", "db.internal"]);
    expect(cleanEgress(Array.from({ length: 60 }, (_, i) => `h${i}.example.com`))).toHaveLength(50);
  });

  it("cleanPackages: requirement strings without whitespace, unique, at most 50", () => {
    expect(
      cleanPackages(["pandas>=2", " openpyxl ", "open pyxl", "", "@scope/pkg@^1.2", "pandas>=2"]),
    ).toEqual(["pandas>=2", "openpyxl", "@scope/pkg@^1.2"]);
  });

  it("jsonObjectIn: the first object, from the whole text, a fence or the outermost braces", () => {
    expect(jsonObjectIn('{"a": 1}')).toEqual({ a: 1 });
    expect(jsonObjectIn('x ```json\n{"a": 1}\n``` y')).toEqual({ a: 1 });
    expect(jsonObjectIn('pre {"a": {"b": 2}} post')).toEqual({ a: { b: 2 } });
    expect(jsonObjectIn("nothing")).toBeNull();
    expect(jsonObjectIn("[1]")).toBeNull();
  });
});

describe("manifestYaml", () => {
  it("writes YAML an upload accepts, in the built-ins' key order, under the size cap", () => {
    const { manifest } = manifestFromReply(
      JSON.stringify({
        summary: "Reports: sales, by region.",
        tags: ["sales"],
        capabilities: { egress: ["api.example.com"] },
      }),
      SEED,
    );
    const bytes = manifestYaml(manifest);
    const text = new TextDecoder().decode(bytes);
    expect(text.split("\n")[0]).toBe("apiVersion: kobe.dev/skill/v1");
    expect(text.indexOf("name:")).toBeLessThan(text.indexOf("version:"));
    expect(text.indexOf("summary:")).toBeLessThan(text.indexOf("tags:"));
    expect(text.indexOf("tags:")).toBeLessThan(text.indexOf("license:"));
    expect(text.indexOf("license:")).toBeLessThan(text.indexOf("capabilities:"));
    expect(bytes.length).toBeLessThanOrEqual(MANIFEST_MAX_BYTES);
    const back = readManifest(bytes, "sales-report");
    expect(back.ok && back.value).toEqual(manifest);
  });

  it("refuses a manifest whose name is not the skill's (never a rename)", () => {
    const bytes = manifestYaml(manifestFromSeed(SEED));
    expect(readManifest(bytes, "other").ok).toBe(false);
  });
});
