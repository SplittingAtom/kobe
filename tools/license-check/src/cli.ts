import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  findMalformedExceptions,
  findPendingExceptions,
  findStaleExceptions,
  findViolations,
  type LicenseExceptions,
  type LicenseReport,
} from "./policy.js";
import { fail, reportPending } from "./output.js";

// Default: the pnpm workspace. LICENSE_REPORT/LICENSE_EXCEPTIONS check another report instead
// (e.g. the sandbox image: images/sandbox/collect-licenses.sh).
const exceptionsPath =
  process.env.LICENSE_EXCEPTIONS ??
  fileURLToPath(new URL("../license-exceptions.json", import.meta.url));
const reportPath = process.env.LICENSE_REPORT;
const lockfilePath = fileURLToPath(new URL("../../../pnpm-lock.yaml", import.meta.url));

/** Packages excluded via pnpm-workspace.yaml; they never install, so the report can't see them. */
const EXCLUDED_PACKAGES = [/^\s+sharp@/m, /^\s+'?@img\//m];

function loadReport(): LicenseReport {
  if (reportPath) return JSON.parse(readFileSync(reportPath, "utf8")) as LicenseReport;
  // Covers production and development dependencies across the whole workspace.
  const output = execFileSync("pnpm", ["licenses", "list", "--json", "--recursive"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(output) as LicenseReport;
}

function main(): void {
  const exceptions = JSON.parse(readFileSync(exceptionsPath, "utf8")) as LicenseExceptions;
  const malformed = findMalformedExceptions(exceptions);
  if (malformed.length > 0) {
    fail([
      `Malformed license exceptions: ${malformed.join(", ")}`,
      "Each needs a reason, pinned versions, and either approvedBy + approvedOn (YYYY-MM-DD) from",
      'Chris or pending: "gate review" (asked at the next gate review), not both.',
    ]);
  }

  const lockfile = reportPath ? "" : readFileSync(lockfilePath, "utf8");
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
      "Allowed: MIT/Apache/BSD/MPL family. Add a version-pinned exception with a reason to",
      `${exceptionsPath}, marked pending: "gate review" until Chris decides (docs/licensing.md).`,
    ]);
  }
  if (stale.length > 0) {
    fail([`Stale license exceptions (no matching package/version): ${stale.join(", ")}`]);
  }
  reportPending(
    findPendingExceptions(exceptions).map((name) => `exception ${name} (${exceptionsPath})`),
  );
  console.log(
    `License check passed: ${total} packages, ${Object.keys(exceptions).length} documented exceptions.`,
  );
}

main();
