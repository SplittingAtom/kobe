/**
 * The hand-maintained part of the third-party inventory (tools/license-check/inventory.yaml):
 * images, chart and cluster components, dev/test tools and assets, plus the settings that turn
 * the generated reports into tables. Validated here so a malformed entry fails with its path.
 */
import { parse } from "yaml";
import { evaluateLicense } from "../policy.js";

export interface Approval {
  readonly by: string;
  readonly on: string;
  readonly ref?: string;
}

export interface HandRow {
  readonly id: string;
  readonly component: string;
  readonly version: string;
  readonly license: string;
  readonly use: string;
  readonly where: string;
  readonly link: string;
  /** Normalised image repositories this row covers (Dockerfile FROM, chart, dev and CI images). */
  readonly images: readonly string[];
  /** Why a component outside the allowed family is acceptable (separate program, data, ...). */
  readonly reason?: string;
  readonly approval?: Approval;
}

export interface HandSection {
  readonly id: string;
  readonly title: string;
  readonly intro: string;
  readonly rows: readonly HandRow[];
}

export interface PlatformFamily {
  readonly pattern: string;
  readonly license: string;
  readonly link: string;
}

export interface LicenseOverride {
  readonly package: string;
  readonly license: string;
  readonly reportedAs: readonly string[];
  readonly reason: string;
}

export interface ImageReportSource {
  readonly id: string;
  readonly title: string;
  readonly intro: string;
  readonly image: string;
  readonly report: string;
  readonly exceptions: string;
  readonly locations: Readonly<Record<string, string>>;
}

export interface NpmLockfileSource {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly section: string;
  readonly use: string;
  readonly where: string;
}

export type ChartValueClass = "first-party" | "site-provided" | readonly string[];

export interface Inventory {
  readonly notice: string;
  readonly npm: {
    readonly title: string;
    readonly intro: string;
    readonly exceptions: string;
    readonly deployables: Readonly<Record<string, string>>;
    readonly platformPackages: readonly PlatformFamily[];
    readonly licenseOverrides: readonly LicenseOverride[];
  };
  readonly imageReports: readonly ImageReportSource[];
  readonly npmLockfiles: readonly NpmLockfileSource[];
  readonly sections: readonly HandSection[];
  /**
   * Every top-level key of charts/kobe/values.yaml: "first-party" (Kobe's own components),
   * "site-provided" (a service the site operates, Kobe ships nothing) or the row ids it brings in.
   */
  readonly chartValues: Readonly<Record<string, ChartValueClass>>;
}

class SourceError extends Error {}

function fail(path: string, message: string): never {
  throw new SourceError(`inventory.yaml ${path}: ${message}`);
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(path, "must be a non-empty string");
  return value.trim();
}

function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be a mapping");
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "must be a list");
  return value;
}

function strings(value: unknown, path: string): string[] {
  return list(value ?? [], path).map((v, i) => str(v, `${path}[${i}]`));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function approval(value: unknown, path: string): Approval | undefined {
  if (value === undefined) return undefined;
  const a = obj(value, path);
  const on = a.on instanceof Date ? a.on.toISOString().slice(0, 10) : str(a.on, `${path}.on`);
  if (!ISO_DATE.test(on)) fail(`${path}.on`, "must be YYYY-MM-DD");
  return {
    by: str(a.by, `${path}.by`),
    on,
    ...(a.ref === undefined ? {} : { ref: str(a.ref, `${path}.ref`) }),
  };
}

function row(value: unknown, path: string): HandRow {
  const r = obj(value, path);
  const license = str(r.license, `${path}.license`);
  const reason = r.reason === undefined ? undefined : str(r.reason, `${path}.reason`);
  const approved = approval(r.approval, `${path}.approval`);
  return {
    id: str(r.id, `${path}.id`),
    component: str(r.component, `${path}.component`),
    version: str(String(r.version ?? ""), `${path}.version`),
    license,
    use: str(r.use, `${path}.use`),
    where: str(r.where, `${path}.where`),
    link: str(r.link, `${path}.link`),
    images: strings(r.images, `${path}.images`),
    ...(reason === undefined ? {} : { reason }),
    ...(approved === undefined ? {} : { approval: approved }),
  };
}

function stringMap(value: unknown, path: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(obj(value, path)).map(([k, v]) => [k, str(v, `${path}.${k}`)]),
  );
}

export function parseInventory(text: string): Inventory {
  const root = obj(parse(text), "(root)");
  const npm = obj(root.npm, "npm");
  const sections = list(root.sections, "sections").map((s, i) => {
    const section = obj(s, `sections[${i}]`);
    return {
      id: str(section.id, `sections[${i}].id`),
      title: str(section.title, `sections[${i}].title`),
      intro: str(section.intro, `sections[${i}].intro`),
      rows: list(section.rows, `sections[${i}].rows`).map((r, j) =>
        row(r, `sections[${i}].rows[${j}]`),
      ),
    };
  });
  const ids = sections.flatMap((s) => s.rows.map((r) => r.id));
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) fail("sections", `duplicate row id ${duplicate}`);
  const chartValues = Object.fromEntries(
    Object.entries(obj(root.chartValues, "chartValues")).map(([key, v]) => {
      if (v === "first-party" || v === "site-provided") return [key, v];
      const refs = strings(v, `chartValues.${key}`);
      const unknown = refs.find((ref) => !ids.includes(ref));
      if (refs.length === 0 || unknown !== undefined) {
        fail(
          `chartValues.${key}`,
          `must be "first-party", "site-provided" or a list of row ids (${unknown ?? "empty"})`,
        );
      }
      return [key, refs];
    }),
  );
  const sectionIds = sections.map((s) => s.id);
  return {
    notice: str(root.notice, "notice"),
    npm: {
      title: str(npm.title, "npm.title"),
      intro: str(npm.intro, "npm.intro"),
      exceptions: str(npm.exceptions, "npm.exceptions"),
      deployables: stringMap(npm.deployables, "npm.deployables"),
      platformPackages: list(npm.platformPackages, "npm.platformPackages").map((p, i) => {
        const f = obj(p, `npm.platformPackages[${i}]`);
        const license = str(f.license, `npm.platformPackages[${i}].license`);
        if (!evaluateLicense(license).allowed) {
          fail(`npm.platformPackages[${i}]`, `${license} is outside the allowed family`);
        }
        return {
          pattern: str(f.pattern, `npm.platformPackages[${i}].pattern`),
          license,
          link: str(f.link, `npm.platformPackages[${i}].link`),
        };
      }),
      licenseOverrides: list(npm.licenseOverrides ?? [], "npm.licenseOverrides").map((o, i) => {
        const p = `npm.licenseOverrides[${i}]`;
        const f = obj(o, p);
        return {
          package: str(f.package, `${p}.package`),
          license: str(f.license, `${p}.license`),
          reportedAs: strings(f.reportedAs, `${p}.reportedAs`),
          reason: str(f.reason, `${p}.reason`),
        };
      }),
    },
    imageReports: list(root.imageReports, "imageReports").map((r, i) => {
      const p = `imageReports[${i}]`;
      const f = obj(r, p);
      return {
        id: str(f.id, `${p}.id`),
        title: str(f.title, `${p}.title`),
        intro: str(f.intro, `${p}.intro`),
        image: str(f.image, `${p}.image`),
        report: str(f.report, `${p}.report`),
        exceptions: str(f.exceptions, `${p}.exceptions`),
        locations: stringMap(f.locations, `${p}.locations`),
      };
    }),
    npmLockfiles: list(root.npmLockfiles ?? [], "npmLockfiles").map((l, i) => {
      const p = `npmLockfiles[${i}]`;
      const f = obj(l, p);
      const section = str(f.section, `${p}.section`);
      if (!sectionIds.includes(section)) fail(`${p}.section`, `no section ${section}`);
      return {
        id: str(f.id, `${p}.id`),
        title: str(f.title, `${p}.title`),
        path: str(f.path, `${p}.path`),
        section,
        use: str(f.use, `${p}.use`),
        where: str(f.where, `${p}.where`),
      };
    }),
    sections,
    chartValues,
  };
}

/** Hand rows outside the allowed family that lack a reason or Chris's recorded approval. */
export function unapprovedRows(inventory: Inventory): string[] {
  return inventory.sections.flatMap((section) =>
    section.rows
      .filter((r) => !evaluateLicense(r.license).allowed && (!r.reason || !r.approval))
      .map(
        (r) =>
          `${section.id}/${r.id}: ${r.license} is outside the allowed family (MIT/Apache/BSD/MPL); ` +
          "it needs a reason and Chris's approval {by, on} (spec D3)",
      ),
  );
}
