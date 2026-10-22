import { describe, expect, it } from "vitest";
import { readCatalogJson, writeCatalogJson } from "./catalog-json.js";

const h = (c: string) => c.repeat(64);

describe("mirror catalog.json (KOBE-343)", () => {
  it("adds versions in name and semver order, deterministically", () => {
    const a = writeCatalogJson(
      {},
      {
        name: "zeta",
        semver: "1.0.0",
        tag: "zeta/v1.0.0",
        runtimeHash: h("a"),
        packageHash: h("b"),
      },
    );
    const b = writeCatalogJson(readCatalogJson(a), {
      name: "alpha",
      semver: "0.10.0",
      tag: "alpha/v0.10.0",
      runtimeHash: h("c"),
      packageHash: h("d"),
    });
    const c = writeCatalogJson(readCatalogJson(b), {
      name: "alpha",
      semver: "0.9.0",
      tag: "alpha/v0.9.0",
      runtimeHash: h("e"),
      packageHash: h("f"),
    });
    const doc = JSON.parse(new TextDecoder().decode(c));
    expect(doc.apiVersion).toBe("kobe.dev/skill-catalog-mirror/v1");
    expect(Object.keys(doc.skills)).toEqual(["alpha", "zeta"]);
    expect(Object.keys(doc.skills.alpha.versions)).toEqual(["0.9.0", "0.10.0"]);
    // Re-adding the same entry changes nothing.
    expect(
      writeCatalogJson(readCatalogJson(c), {
        name: "alpha",
        semver: "0.9.0",
        tag: "alpha/v0.9.0",
        runtimeHash: h("e"),
        packageHash: h("f"),
      }),
    ).toEqual(c);
  });

  it("drops what doesn't parse instead of carrying it on", () => {
    const junk = new TextEncoder().encode(
      JSON.stringify({
        skills: {
          "Bad Name": {},
          ok: {
            versions: { "1.0": {}, "1.0.0": { tag: "t", runtimeHash: "x", packageHash: h("a") } },
          },
        },
      }),
    );
    expect(readCatalogJson(junk)).toEqual({});
    expect(readCatalogJson(new TextEncoder().encode("not json"))).toEqual({});
    expect(readCatalogJson(null)).toEqual({});
  });
});
