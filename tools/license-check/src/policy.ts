/**
 * Dependency license policy (spec D3): MIT / Apache / BSD / MPL only; AGPL and source-available
 * licenses are excluded. Permissive licenses equivalent to MIT/BSD (ISC, 0BSD, ...) are allowed;
 * anything else needs a documented, version-pinned exception in license-exceptions.json.
 */
import { parseSpdx, type SpdxNode } from "./spdx.js";

export const ALLOWED_LICENSES: ReadonlySet<string> = new Set([
  "MIT",
  "MIT-0",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "ISC",
  "MPL-2.0",
  // Public-domain and permissive equivalents of MIT/BSD.
  "BlueOak-1.0.0",
  "Zlib",
  "CC0-1.0",
  "Unlicense",
]);

/** SPDX `WITH` exceptions that only add permissions to an already-allowed license. */
export const ALLOWED_EXCEPTIONS: ReadonlySet<string> = new Set(["LLVM-exception"]);

export interface LicenseVerdict {
  readonly allowed: boolean;
}

export interface PackageEntry {
  readonly name: string;
  readonly versions: readonly string[];
}

/** Shape of `pnpm licenses list --json`: license string → packages. */
export type LicenseReport = Readonly<Record<string, readonly PackageEntry[]>>;

export interface LicenseException {
  readonly license: string;
  /** Exact package versions covered; a new version must be re-justified. */
  readonly versions: readonly string[];
  readonly reason: string;
}

export type LicenseExceptions = Readonly<Record<string, LicenseException>>;

export interface Violation {
  readonly name: string;
  readonly versions: readonly string[];
  readonly license: string;
}

function isAllowed(node: SpdxNode): boolean {
  switch (node.kind) {
    case "license":
      return (
        ALLOWED_LICENSES.has(node.id) &&
        (node.exception === undefined || ALLOWED_EXCEPTIONS.has(node.exception))
      );
    case "and":
      return isAllowed(node.left) && isAllowed(node.right);
    case "or":
      return isAllowed(node.left) || isAllowed(node.right);
  }
}

/** Evaluates an SPDX expression; malformed or empty expressions are rejected (fail closed). */
export function evaluateLicense(expression: string): LicenseVerdict {
  try {
    return { allowed: isAllowed(parseSpdx(expression)) };
  } catch {
    return { allowed: false };
  }
}

function isExcepted(pkg: PackageEntry, license: string, exceptions: LicenseExceptions): boolean {
  const exception = exceptions[pkg.name];
  return (
    exception !== undefined &&
    exception.license === license &&
    pkg.versions.every((v) => exception.versions.includes(v))
  );
}

export function findViolations(report: LicenseReport, exceptions: LicenseExceptions): Violation[] {
  return Object.entries(report).flatMap(([license, packages]) =>
    evaluateLicense(license).allowed
      ? []
      : packages
          .filter((pkg) => !isExcepted(pkg, license, exceptions))
          .map((pkg) => ({ name: pkg.name, versions: pkg.versions, license })),
  );
}

/**
 * Exceptions that no longer match an installed package at a named version. The license is not
 * compared here: where a package's license is read from differs between pnpm stores (a package
 * without a `license` field is `Unknown` on a fresh CI store, `MIT` from cached registry metadata
 * locally), and `findViolations` already rejects a package whose reported license differs from
 * the excepted one.
 */
export function findStaleExceptions(
  report: LicenseReport,
  exceptions: LicenseExceptions,
): string[] {
  return Object.entries(exceptions)
    .filter(
      ([name, exception]) =>
        !Object.values(report)
          .flat()
          .some(
            (pkg) => pkg.name === name && pkg.versions.some((v) => exception.versions.includes(v)),
          ),
    )
    .map(([name]) => name);
}
