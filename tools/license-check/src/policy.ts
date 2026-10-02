/**
 * Dependency license policy (spec D3): MIT / Apache / BSD / MPL only; AGPL and source-available
 * licenses are excluded. Permissive licenses equivalent to MIT/BSD (ISC, 0BSD, ...) are allowed;
 * anything else needs a documented per-package exception in license-exceptions.json.
 */
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
  "CC0-1.0",
  "Unlicense",
]);

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
  readonly reason: string;
}

export type LicenseExceptions = Readonly<Record<string, LicenseException>>;

export interface Violation {
  readonly name: string;
  readonly versions: readonly string[];
  readonly license: string;
}

function stripParens(expr: string): string {
  const trimmed = expr.trim();
  return trimmed.startsWith("(") && trimmed.endsWith(")")
    ? stripParens(trimmed.slice(1, -1))
    : trimmed;
}

/** Evaluates a (flat) SPDX expression: OR passes if any branch passes, AND only if all do. */
export function evaluateLicense(expression: string): LicenseVerdict {
  const expr = stripParens(expression);
  if (expr === "") return { allowed: false };
  if (/\sOR\s/.test(expr)) {
    return { allowed: expr.split(/\s+OR\s+/).some((part) => evaluateLicense(part).allowed) };
  }
  if (/\sAND\s/.test(expr)) {
    return { allowed: expr.split(/\s+AND\s+/).every((part) => evaluateLicense(part).allowed) };
  }
  return { allowed: ALLOWED_LICENSES.has(expr) };
}

export function findViolations(report: LicenseReport, exceptions: LicenseExceptions): Violation[] {
  return Object.entries(report).flatMap(([license, packages]) =>
    evaluateLicense(license).allowed
      ? []
      : packages
          .filter((pkg) => exceptions[pkg.name]?.license !== license)
          .map((pkg) => ({ name: pkg.name, versions: pkg.versions, license })),
  );
}
