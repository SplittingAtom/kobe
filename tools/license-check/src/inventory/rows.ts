/**
 * Turns the generated sources (pnpm workspace, image reports, npm lockfiles) into inventory rows
 * and NOTICE texts. Problems are collected rather than thrown, so one run lists all of them.
 */
import { evaluateLicense, type LicenseExceptions } from "../policy.js";
import type { LockedPackage } from "./lockfile.js";
import type { ImageReportSource, Inventory, NpmLockfileSource, PlatformFamily } from "./source.js";

export interface Row {
  readonly component: string;
  readonly version: string;
  readonly license: string;
  readonly use: string;
  readonly where: string;
  readonly link: string;
  readonly excepted?: boolean;
}

export interface Notice {
  readonly component: string;
  readonly version: string;
  readonly where: string;
  readonly text: string;
}

export interface Rows {
  readonly rows: Row[];
  readonly notices: Notice[];
  readonly problems: string[];
}

/** `pnpm licenses list --json` entry. */
export interface PnpmEntry {
  readonly name: string;
  readonly versions: readonly string[];
  readonly paths?: readonly string[];
}

export type PnpmReport = Readonly<Record<string, readonly PnpmEntry[]>>;

/** Reads files of an installed package (injected so tests need no node_modules). */
export interface PackageFiles {
  licenseFile(dir: string): string | undefined;
  notice(dir: string): string | undefined;
}

const FIRST_PARTY = /^@kobe\//;

export function npmPage(name: string, version: string): string {
  return `https://www.npmjs.com/package/${name}/v/${version}`;
}

function excepted(exceptions: LicenseExceptions, name: string, version: string): boolean {
  return exceptions[name]?.versions.includes(version) ?? false;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function familyOf(families: readonly PlatformFamily[], name: string): PlatformFamily | undefined {
  return families.find((f) => globToRegExp(f.pattern).test(name));
}

interface Installed {
  readonly license: string;
  readonly dir: string | undefined;
}

/** name@version → reported license and install directory. */
export function indexReport(report: PnpmReport): Map<string, Installed> {
  const index = new Map<string, Installed>();
  for (const [license, entries] of Object.entries(report)) {
    for (const entry of entries) {
      for (const version of entry.versions) {
        const marker = `${entry.name.replace("/", "+")}@${version}`;
        const dir = entry.paths?.find((p) => {
          const at = p.indexOf(marker);
          return at !== -1 && /^(?:$|[_/(])/.test(p.slice(at + marker.length));
        });
        index.set(`${entry.name}@${version}`, { license, dir });
      }
    }
  }
  return index;
}

function workspaceLicense(
  pkg: LockedPackage,
  installed: Installed | undefined,
  inventory: Inventory,
  problems: string[],
): { license: string; family?: PlatformFamily } {
  const key = `${pkg.name}@${pkg.version}`;
  if (pkg.platformOnly) {
    const family = familyOf(inventory.npm.platformPackages, pkg.name);
    if (!family) {
      problems.push(`${key} is a platform-specific package with no npm.platformPackages entry`);
      return { license: installed?.license ?? "UNKNOWN" };
    }
    if (installed && installed.license !== family.license) {
      problems.push(
        `${key} reports ${installed.license}, but npm.platformPackages says ${family.license}`,
      );
    }
    return { license: family.license, family };
  }
  const override = inventory.npm.licenseOverrides.find((o) => o.package === key);
  if (!installed) {
    problems.push(
      `${key} is in pnpm-lock.yaml but not in the pnpm licenses report (install first)`,
    );
    return { license: override?.license ?? "UNKNOWN" };
  }
  if (!override) return { license: installed.license };
  if (installed.license !== override.license && !override.reportedAs.includes(installed.license)) {
    problems.push(
      `${key} reports ${installed.license}; npm.licenseOverrides expects ${override.license}`,
    );
  }
  return { license: override.license };
}

export function workspaceRows(
  packages: readonly LockedPackage[],
  report: PnpmReport,
  inventory: Inventory,
  exceptions: LicenseExceptions,
  files: PackageFiles,
): Rows {
  const index = indexReport(report);
  const problems: string[] = [];
  const rows: Row[] = [];
  const notices: Notice[] = [];
  const known = new Set(packages.map((p) => `${p.name}@${p.version}`));
  for (const key of index.keys()) {
    if (!known.has(key) && !FIRST_PARTY.test(key)) {
      problems.push(`${key} is installed but not in pnpm-lock.yaml (reinstall)`);
    }
  }
  for (const pkg of packages) {
    if (FIRST_PARTY.test(pkg.name)) continue;
    const installed = index.get(`${pkg.name}@${pkg.version}`);
    const { license, family } = workspaceLicense(pkg, installed, inventory, problems);
    const images = [...new Set(pkg.shippedBy.map((p) => inventory.npm.deployables[p] ?? p))];
    const licenseFile = family || !installed?.dir ? undefined : files.licenseFile(installed.dir);
    const link = family
      ? family.link
      : licenseFile
        ? `https://unpkg.com/${pkg.name}@${pkg.version}/${licenseFile}`
        : npmPage(pkg.name, pkg.version);
    const shipped = images.length > 0;
    const isExcepted = excepted(exceptions, pkg.name, pkg.version);
    rows.push({
      component: pkg.name,
      version: pkg.version,
      license,
      use: `${shipped ? "linked, bundled" : "dev-only"}${pkg.platformOnly ? " (platform build)" : ""}`,
      where: shipped ? images.sort().join(", ") : "build, lint and test tooling",
      link,
      ...(isExcepted ? { excepted: true } : {}),
    });
    const text = shipped && !family && installed?.dir ? files.notice(installed.dir) : undefined;
    if (text) {
      notices.push({ component: pkg.name, version: pkg.version, where: images.join(", "), text });
    }
  }
  return { rows, notices, problems };
}

/** Collect-licenses entry (images/sandbox/collect-licenses.sh). */
export interface ImageEntry {
  readonly name: string;
  readonly versions: readonly string[];
  readonly ecosystem?: string;
  readonly locations?: readonly string[];
  readonly notice?: string;
}

export type ImageReport = Readonly<Record<string, readonly ImageEntry[]>>;

/** Sorted, stable JSON for the committed copy of an image report. */
export function canonicalImageReport(report: ImageReport): string {
  const sorted = Object.fromEntries(
    Object.keys(report)
      .sort()
      .map((license) => [
        license,
        [...(report[license] ?? [])]
          .map((e) => ({
            name: e.name,
            versions: [...e.versions].sort(),
            ...(e.ecosystem === undefined ? {} : { ecosystem: e.ecosystem }),
            ...(e.locations === undefined ? {} : { locations: [...e.locations].sort() }),
            ...(e.notice === undefined ? {} : { notice: e.notice }),
          }))
          .sort((a, b) =>
            `${a.ecosystem ?? ""} ${a.name} ${a.versions.join()}`.localeCompare(
              `${b.ecosystem ?? ""} ${b.name} ${b.versions.join()}`,
            ),
          ),
      ]),
  );
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

export function imageRows(
  report: ImageReport,
  source: ImageReportSource,
  exceptions: LicenseExceptions,
): Rows {
  const problems: string[] = [];
  const rows: Row[] = [];
  const notices: Notice[] = [];
  for (const [license, entries] of Object.entries(report)) {
    for (const entry of entries) {
      if (FIRST_PARTY.test(entry.name)) continue;
      const where = (entry.locations ?? []).map((l) => {
        const label = source.locations[l];
        if (!label) problems.push(`${source.report}: no label for location ${l} (${entry.name})`);
        return label ?? l;
      });
      const python = entry.ecosystem === "pypi";
      for (const version of entry.versions) {
        rows.push({
          component: entry.name,
          version,
          license,
          use: python ? "bundled (Python package)" : "bundled (npm package)",
          where: `${source.image}: ${where.join(", ")}`,
          link: python
            ? `https://pypi.org/project/${entry.name}/${version}/`
            : npmPage(entry.name, version),
          ...(excepted(exceptions, entry.name, version) ? { excepted: true } : {}),
        });
        if (entry.notice) {
          notices.push({
            component: entry.name,
            version,
            where: `${source.image} image`,
            text: entry.notice,
          });
        }
      }
    }
  }
  rows.sort((a, b) => `${a.component}@${a.version}`.localeCompare(`${b.component}@${b.version}`));
  return { rows, notices, problems };
}

interface NpmLock {
  readonly packages?: Readonly<
    Record<string, { readonly version?: string; readonly license?: string }>
  >;
}

/** Rows from an npm package-lock.json (v3), checked against the allowed family. */
export function npmLockfileRows(
  lock: NpmLock,
  source: NpmLockfileSource,
  exceptions: LicenseExceptions = {},
): Rows {
  const problems: string[] = [];
  const seen = new Map<string, Row>();
  for (const [path, pkg] of Object.entries(lock.packages ?? {})) {
    if (path === "" || !pkg.version) continue;
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    const license = pkg.license ?? "UNKNOWN";
    const exception = exceptions[name];
    const isExcepted = exception?.license === license && exception.versions.includes(pkg.version);
    if (!evaluateLicense(license).allowed && !isExcepted) {
      const where = source.exceptions ?? "an exceptions file (npmLockfiles[].exceptions)";
      problems.push(
        `${source.path}: ${name}@${pkg.version} is ${license} (outside the allowed family): ` +
          `add an exception to ${where}`,
      );
    }
    seen.set(`${name}@${pkg.version}`, {
      component: name,
      version: pkg.version,
      license,
      use: source.use,
      where: source.where,
      link: npmPage(name, pkg.version),
      ...(isExcepted ? { excepted: true } : {}),
    });
  }
  const rows = [...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, r]) => r);
  return { rows, notices: [], problems };
}
