import { describe, expect, it } from "vitest";
import type { LockedPackage } from "./lockfile.js";
import {
  canonicalImageReport,
  imageRows,
  indexReport,
  npmLockfileRows,
  workspaceRows,
  type PackageFiles,
} from "./rows.js";
import type { ImageReportSource, Inventory } from "./source.js";

const inventory = {
  npm: {
    deployables: { "apps/web": "web" },
    platformPackages: [{ pattern: "@esbuild/*", license: "MIT", link: "https://esbuild/LICENSE" }],
    licenseOverrides: [
      { package: "khroma@2.1.0", license: "MIT", reportedAs: ["Unknown"], reason: "no field" },
    ],
  },
} as unknown as Inventory;

const files: PackageFiles = {
  licenseFile: (dir) => (dir.endsWith("/react") ? "LICENSE" : undefined),
  notice: (dir) => (dir.endsWith("/react") ? "React NOTICE" : undefined),
};

const pkg = (name: string, extra: Partial<LockedPackage> = {}): LockedPackage => ({
  name,
  version: "1.0.0",
  platformOnly: false,
  shippedBy: [],
  ...extra,
});

describe("indexReport", () => {
  it("finds each version's directory, not a longer version's", () => {
    const index = indexReport({
      MIT: [
        {
          name: "@types/node",
          versions: ["1.0.1", "1.0.10"],
          paths: [
            "/s/@types+node@1.0.10/node_modules/@types/node",
            "/s/@types+node@1.0.1/n/@types/node",
          ],
        },
      ],
    });
    expect(index.get("@types/node@1.0.1")?.dir).toBe("/s/@types+node@1.0.1/n/@types/node");
    expect(index.get("@types/node@1.0.10")?.dir).toContain("@1.0.10/");
  });
});

describe("workspaceRows", () => {
  const report = {
    MIT: [
      { name: "react", versions: ["1.0.0"], paths: ["/s/react@1.0.0/node_modules/react"] },
      { name: "khroma", versions: ["2.1.0"], paths: [] },
      { name: "@esbuild/darwin-arm64", versions: ["1.0.0"], paths: [] },
    ],
    "CC-BY-4.0": [{ name: "caniuse-lite", versions: ["1.0.0"], paths: [] }],
  };
  const exceptions = {
    "caniuse-lite": { license: "CC-BY-4.0", versions: ["1.0.0"], reason: "data" },
  };

  it("builds rows with use, image, license link, exception mark and NOTICE", () => {
    const result = workspaceRows(
      [
        pkg("react", { shippedBy: ["apps/web"] }),
        pkg("caniuse-lite", { shippedBy: ["apps/web"] }),
        pkg("khroma", { version: "2.1.0" }),
        pkg("@esbuild/darwin-arm64", { platformOnly: true }),
        pkg("@esbuild/linux-x64", { platformOnly: true }),
      ],
      report,
      inventory,
      exceptions,
      files,
    );
    expect(result.problems).toEqual([]);
    expect(result.rows).toEqual([
      {
        component: "react",
        version: "1.0.0",
        license: "MIT",
        use: "linked, bundled",
        where: "web",
        link: "https://unpkg.com/react@1.0.0/LICENSE",
      },
      expect.objectContaining({ component: "caniuse-lite", excepted: true }),
      expect.objectContaining({ component: "khroma", license: "MIT", use: "dev-only" }),
      expect.objectContaining({
        use: "dev-only (platform build)",
        link: "https://esbuild/LICENSE",
      }),
      expect.objectContaining({ component: "@esbuild/linux-x64", license: "MIT" }),
    ]);
    expect(result.notices).toEqual([
      { component: "react", version: "1.0.0", where: "web", text: "React NOTICE" },
    ]);
  });

  it("is the same whether the store reports khroma as MIT or Unknown", () => {
    const unknown = { ...report, MIT: report.MIT.filter((e) => e.name !== "khroma") };
    const withUnknown = { ...unknown, Unknown: [{ name: "khroma", versions: ["2.1.0"] }] };
    const rows = (r: typeof report) =>
      workspaceRows([pkg("khroma", { version: "2.1.0" })], r, inventory, {}, files).rows;
    expect(rows(withUnknown as typeof report)).toEqual(rows(report));
  });

  it("reports packages missing from the report or the lockfile, and unknown platform builds", () => {
    const result = workspaceRows(
      [pkg("left-pad"), pkg("@swc/core-linux", { platformOnly: true })],
      report,
      inventory,
      {},
      files,
    );
    expect(result.problems).toEqual([
      "react@1.0.0 is installed but not in pnpm-lock.yaml (reinstall)",
      "khroma@2.1.0 is installed but not in pnpm-lock.yaml (reinstall)",
      "@esbuild/darwin-arm64@1.0.0 is installed but not in pnpm-lock.yaml (reinstall)",
      "caniuse-lite@1.0.0 is installed but not in pnpm-lock.yaml (reinstall)",
      "left-pad@1.0.0 is in pnpm-lock.yaml but not in the pnpm licenses report (install first)",
      "@swc/core-linux@1.0.0 is a platform-specific package with no npm.platformPackages entry",
    ]);
  });

  it("flags a platform build whose installed license differs from its family", () => {
    const result = workspaceRows(
      [pkg("@esbuild/darwin-arm64", { platformOnly: true })],
      { "GPL-3.0-only": [{ name: "@esbuild/darwin-arm64", versions: ["1.0.0"] }] },
      inventory,
      {},
      files,
    );
    expect(result.problems).toEqual([
      "@esbuild/darwin-arm64@1.0.0 reports GPL-3.0-only, but npm.platformPackages says MIT",
    ]);
  });
});

describe("image reports", () => {
  const source: ImageReportSource = {
    id: "sandbox",
    title: "t",
    intro: "i",
    image: "sandbox",
    report: "r.json",
    exceptions: "e.json",
    locations: { python: "Python", "/opt/pi": "Pi" },
  };
  const report = {
    MIT: [
      { name: "zeta", versions: ["2"], ecosystem: "npm", locations: ["/opt/pi"] },
      { name: "@kobe/protocol", versions: ["0.0.0"], ecosystem: "npm", locations: ["/opt/pi"] },
    ],
    "Apache-2.0": [
      { name: "pyarrow", versions: ["25"], ecosystem: "pypi", locations: ["python"], notice: "N" },
    ],
  };

  it("canonicalises key and entry order", () => {
    const shuffled = { "Apache-2.0": report["Apache-2.0"], MIT: [...report.MIT].reverse() };
    expect(canonicalImageReport(shuffled)).toBe(canonicalImageReport(report));
    expect(Object.keys(JSON.parse(canonicalImageReport(report)))).toEqual(["Apache-2.0", "MIT"]);
  });

  it("renders rows (first-party skipped), links and notices", () => {
    const result = imageRows(report, source, {});
    expect(result.problems).toEqual([]);
    expect(result.rows.map((r) => [r.component, r.where, r.link])).toEqual([
      ["pyarrow", "sandbox: Python", "https://pypi.org/project/pyarrow/25/"],
      ["zeta", "sandbox: Pi", "https://www.npmjs.com/package/zeta/v/2"],
    ]);
    expect(result.notices).toEqual([
      { component: "pyarrow", version: "25", where: "sandbox image", text: "N" },
    ]);
  });

  it("asks for a label for an unknown location", () => {
    const odd = { MIT: [{ name: "x", versions: ["1"], ecosystem: "npm", locations: ["/srv"] }] };
    expect(imageRows(odd, source, {}).problems).toEqual(["r.json: no label for location /srv (x)"]);
  });
});

describe("npmLockfileRows", () => {
  it("lists packages and fails one outside the allowed family", () => {
    const result = npmLockfileRows(
      {
        packages: {
          "": { license: "Apache-2.0" },
          "node_modules/playwright": { version: "1.55.0", license: "Apache-2.0" },
          "node_modules/a/node_modules/bad": { version: "1.0.0", license: "GPL-3.0-only" },
        },
      },
      { id: "e2e", title: "t", path: "p.json", section: "dev", use: "test-only", where: "e2e" },
    );
    expect(result.rows.map((r) => r.component)).toEqual(["bad", "playwright"]);
    expect(result.problems).toEqual([
      "p.json: bad@1.0.0 is GPL-3.0-only (outside the allowed family)",
    ]);
  });
});
