import { describe, expect, it } from "vitest";
import { pickCatalogVersion, type CatalogVersion } from "./catalog-pins.js";

/** KOBE-315 (SK25, SK31): which catalog version an install or member add runs. */
const v = (
  semver: string,
  state: CatalogVersion["state"] = "approved",
  suspended = false,
): CatalogVersion => {
  const [major = 0, minor = 0, patch = 0] = semver.split(".").map(Number);
  return {
    id: `v-${semver}`,
    semver,
    seq: major * 10_000 + minor * 100 + patch,
    state,
    suspended,
    runtimeHash: `r-${semver}`,
    packageHash: `p-${semver}`,
  };
};
const pick = (
  versions: CatalogVersion[],
  pinMode: "pinned" | "within_major" | "latest",
  at: string,
) => pickCatalogVersion(versions, { pinMode, versionId: `v-${at}` });
const semverOf = (r: ReturnType<typeof pickCatalogVersion>) => (r.ok ? r.version.semver : r.reason);

describe("pin modes", () => {
  const versions = [v("1.0.0"), v("1.2.0"), v("1.4.3"), v("2.0.0"), v("2.1.0")];

  it("pinned runs exactly its version", () => {
    expect(semverOf(pick(versions, "pinned", "1.2.0"))).toBe("1.2.0");
  });

  it("Track within major runs the highest approved version of the install's major", () => {
    expect(semverOf(pick(versions, "within_major", "1.0.0"))).toBe("1.4.3");
    expect(semverOf(pick(versions, "within_major", "2.0.0"))).toBe("2.1.0");
  });

  it("Track latest runs the highest approved version of any major", () => {
    expect(semverOf(pick(versions, "latest", "1.0.0"))).toBe("2.1.0");
  });

  it("never runs a version still in review, and an unknown version is not_approved", () => {
    const list = [v("1.0.0"), v("1.1.0", "in_review")];
    expect(semverOf(pick(list, "latest", "1.0.0"))).toBe("1.0.0");
    expect(semverOf(pick(list, "pinned", "1.1.0"))).toBe("not_approved");
    expect(semverOf(pick(list, "pinned", "9.9.9"))).toBe("not_approved");
  });
});

describe("retired versions (SK31)", () => {
  it("a deprecated version keeps working, pinned or tracked", () => {
    const list = [v("1.0.0"), v("1.1.0", "deprecated")];
    expect(semverOf(pick(list, "pinned", "1.1.0"))).toBe("1.1.0");
    expect(semverOf(pick(list, "within_major", "1.0.0"))).toBe("1.1.0");
  });

  it("withdrawn: a pinned install keeps it; tracking moves to the next highest in range", () => {
    const list = [v("1.0.0"), v("1.1.0", "withdrawn"), v("2.0.0")];
    expect(semverOf(pick(list, "pinned", "1.1.0"))).toBe("1.1.0");
    expect(semverOf(pick(list, "within_major", "1.1.0"))).toBe("1.0.0");
  });

  it("revoked stops at once; tracking moves within range only, never across majors", () => {
    const list = [v("1.0.0", "revoked"), v("1.1.0", "revoked"), v("2.0.0")];
    expect(semverOf(pick(list, "pinned", "1.1.0"))).toBe("revoked");
    expect(semverOf(pick(list, "within_major", "1.0.0"))).toBe("revoked");
    expect(semverOf(pick([v("1.0.0"), v("1.1.0", "revoked")], "within_major", "1.1.0"))).toBe(
      "1.0.0",
    );
  });

  it("a suspended version never runs, and an older one does not take its place", () => {
    const list = [v("1.0.0"), v("1.1.0", "approved", true)];
    expect(semverOf(pick(list, "within_major", "1.0.0"))).toBe("suspended");
    expect(semverOf(pick(list, "pinned", "1.1.0"))).toBe("suspended");
    expect(semverOf(pick(list, "pinned", "1.0.0"))).toBe("1.0.0");
  });
});
