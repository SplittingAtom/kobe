import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findViolations, type LicenseExceptions, type LicenseReport } from "./policy.js";

const exceptionsPath = fileURLToPath(new URL("../license-exceptions.json", import.meta.url));

function loadReport(): LicenseReport {
  // Covers production and development dependencies across the whole workspace.
  const output = execFileSync("pnpm", ["licenses", "list", "--json", "--recursive"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(output) as LicenseReport;
}

function main(): void {
  const exceptions = JSON.parse(readFileSync(exceptionsPath, "utf8")) as LicenseExceptions;
  const report = loadReport();
  const violations = findViolations(report, exceptions);
  const total = Object.values(report).reduce((n, pkgs) => n + pkgs.length, 0);

  if (violations.length > 0) {
    console.error(
      `License check failed: ${violations.length} of ${total} packages are not allowed.`,
    );
    for (const v of violations) console.error(`  ${v.name}@${v.versions.join(",")}  ${v.license}`);
    console.error(
      "Allowed: MIT/Apache/BSD/MPL family. Document justified exceptions in license-exceptions.json.",
    );
    process.exit(1);
  }
  console.log(
    `License check passed: ${total} packages, ${Object.keys(exceptions).length} documented exceptions.`,
  );
}

main();
