import { describe, expect, it } from "vitest";
import { evaluateLicense, findViolations } from "./policy.js";

describe("evaluateLicense", () => {
  it.each(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "MPL-2.0", "ISC", "0BSD"])(
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

  it("honours a documented per-package exception only for the exact license", () => {
    const exceptions = {
      "@img/sharp-libvips-linux-x64": { license: "LGPL-3.0-or-later", reason: "test" },
      "bad-lib": { license: "MIT", reason: "wrong license on purpose" },
    };
    expect(findViolations(report, exceptions).map((v) => v.name)).toEqual(["bad-lib"]);
  });
});
