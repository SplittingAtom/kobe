import { describe, expect, it } from "vitest";
import { evaluateLicense, findStaleExceptions, findViolations } from "./policy.js";

describe("evaluateLicense", () => {
  it.each(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "MPL-2.0", "ISC", "0BSD", "Zlib"])(
    "allows %s",
    (license) => {
      expect(evaluateLicense(license).allowed).toBe(true);
    },
  );

  it.each([
    "AGPL-3.0-only",
    "GPL-3.0-or-later",
    "LGPL-3.0-or-later",
    "SSPL-1.0",
    "BUSL-1.1",
    "Elastic-2.0",
    "CC-BY-NC-4.0",
    "UNKNOWN",
    "",
  ])("rejects %s", (license) => {
    expect(evaluateLicense(license).allowed).toBe(false);
  });

  it("allows an OR expression when any branch is allowed", () => {
    expect(evaluateLicense("(MIT OR GPL-3.0-only)").allowed).toBe(true);
  });

  it.each([
    ["(MIT OR X) AND (AGPL-3.0-only OR GPL-3.0-only)", false],
    ["MIT AND (AGPL-3.0-only OR Apache-2.0)", true],
    ["MIT AND (AGPL-3.0-only OR GPL-3.0-only)", false],
    ["(MIT) OR (Apache-2.0)", true],
    ["(MIT) AND (BSD-3-Clause)", true],
    ["(GPL-3.0-only AND MIT) OR (Apache-2.0 AND ISC)", true],
    ["(GPL-3.0-only AND MIT) OR (Apache-2.0 AND SSPL-1.0)", false],
    ["MIT or GPL-3.0-only", true],
    ["Apache-2.0 WITH LLVM-exception", true],
    ["GPL-2.0-only WITH Classpath-exception-2.0", false],
    ["Apache-2.0 WITH Made-Up-exception", false],
  ])("evaluates nested expression %s → %s", (license, allowed) => {
    expect(evaluateLicense(license).allowed).toBe(allowed);
  });

  it.each(["(MIT", "MIT)", "MIT OR", "AND MIT", "MIT Apache-2.0", "()"])(
    "fails closed on malformed expression %s",
    (license) => {
      expect(evaluateLicense(license).allowed).toBe(false);
    },
  );

  it("rejects an AND expression when any branch is rejected", () => {
    expect(evaluateLicense("(MIT AND LGPL-3.0-only)").allowed).toBe(false);
    expect(evaluateLicense("MIT AND BSD-3-Clause").allowed).toBe(true);
  });
});

describe("findViolations", () => {
  const report = {
    MIT: [{ name: "left-pad", versions: ["1.0.0"] }],
    "AGPL-3.0-only": [{ name: "bad-lib", versions: ["2.0.0"] }],
    "LGPL-3.0-or-later": [{ name: "@img/sharp-libvips-linux-x64", versions: ["1.0.0"] }],
  };

  it("lists packages whose license is not allowed", () => {
    expect(findViolations(report, {})).toEqual([
      { name: "bad-lib", versions: ["2.0.0"], license: "AGPL-3.0-only" },
      { name: "@img/sharp-libvips-linux-x64", versions: ["1.0.0"], license: "LGPL-3.0-or-later" },
    ]);
  });

  it("honours a documented per-package exception only for the exact license and versions", () => {
    const exceptions = {
      "@img/sharp-libvips-linux-x64": {
        license: "LGPL-3.0-or-later",
        versions: ["1.0.0"],
        reason: "test",
      },
      "bad-lib": { license: "MIT", versions: ["2.0.0"], reason: "wrong license on purpose" },
    };
    expect(findViolations(report, exceptions).map((v) => v.name)).toEqual(["bad-lib"]);
  });

  it("does not let an exception cover a version it does not name", () => {
    const exceptions = {
      "@img/sharp-libvips-linux-x64": {
        license: "LGPL-3.0-or-later",
        versions: ["0.9.0"],
        reason: "test",
      },
    };
    expect(findViolations(report, exceptions).map((v) => v.name)).toContain(
      "@img/sharp-libvips-linux-x64",
    );
  });
});

describe("findStaleExceptions", () => {
  it("reports exceptions that match no installed package version", () => {
    const report = { "CC-BY-4.0": [{ name: "caniuse-lite", versions: ["1.0.2"] }] };
    const exceptions = {
      "caniuse-lite": { license: "CC-BY-4.0", versions: ["1.0.2"], reason: "data" },
      "gone-lib": { license: "CC-BY-4.0", versions: ["1.0.0"], reason: "removed" },
      "caniuse-old": { license: "CC-BY-4.0", versions: ["0.1.0"], reason: "old" },
    };
    expect(findStaleExceptions(report, exceptions)).toEqual(["gone-lib", "caniuse-old"]);
  });

  it("does not compare the license: stores differ in where they read it from", () => {
    const report = { MIT: [{ name: "khroma", versions: ["2.1.0"] }] };
    const exceptions = { khroma: { license: "Unknown", versions: ["2.1.0"], reason: "no field" } };
    expect(findStaleExceptions(report, exceptions)).toEqual([]);
  });
});
