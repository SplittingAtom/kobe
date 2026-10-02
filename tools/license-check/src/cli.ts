import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  findStaleExceptions,
  findViolations,
  type LicenseExceptions,
  type LicenseReport,
} from "./policy.js";

const exceptionsPath = fileURLToPath(new URL("../license-exceptions.json", import.meta.url));
const lockfilePath = fileURLToPath(new URL("../../../pnpm-lock.yaml", import.meta.url));

/** Packages excluded via pnpm-workspace.yaml; they never install, so the report can't see them. */
const EXCLUDED_PACKAGES = [/^\s+sharp@/m, /^\s+'?@img\//m];

function loadReport(): LicenseReport {
  // Covers production and development dependencies across the whole workspace.
  const output = execFileSync("pnpm", ["licenses", "list", "--json", "--recursive"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(output) as LicenseReport;
}

function fail(lines: readonly string[]): never {
  for (const line of lines) console.error(line);
  process.exit(1);
}

function main(): void {
  const exceptions = JSON.parse(readFileSync(exceptionsPath, "utf8")) as LicenseExceptions;
  const unjustified = Object.entries(exceptions)
    .filter(([, e]) => !e.reason?.trim() || !Array.isArray(e.versions) || e.versions.length === 0)
    .map(([name]) => name);
  if (unjustified.length > 0) {
    fail([`License exceptions need a reason and pinned versions: ${unjustified.join(", ")}`]);
  }

  const lockfile = readFileSync(lockfilePath, "utf8");
  const reintroduced = EXCLUDED_PACKAGES.filter((pattern) => pattern.test(lockfile));
  if (reintroduced.length > 0) {
    fail(["pnpm-lock.yaml contains sharp/@img packages (LGPL libvips); keep them excluded."]);
  }

  const report = loadReport();
  const violations = findViolations(report, exceptions);
  const stale = findStaleExceptions(report, exceptions);
  const total = Object.values(report).reduce((n, pkgs) => n + pkgs.length, 0);

  if (violations.length > 0) {
    fail([
      `License check failed: ${violations.length} of ${total} packages are not allowed.`,
      ...violations.map((v) => `  ${v.name}@${v.versions.join(",")}  ${v.license}`),
      "Allowed: MIT/Apache/BSD/MPL family. Document justified exceptions in license-exceptions.json.",
    ]);
  }
  if (stale.length > 0) {
    fail([`Stale license exceptions (no matching package/version): ${stale.join(", ")}`]);
  }
  console.log(
    `License check passed: ${total} packages, ${Object.keys(exceptions).length} documented exceptions.`,
  );
}

main();
