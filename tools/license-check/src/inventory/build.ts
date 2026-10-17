/** Assembles the inventory from the repository: generated tables, coverage checks, NOTICE. */
import type { LicenseExceptions } from "../policy.js";
import {
  chartValueDrift,
  chartValueKeys,
  dockerfileImages,
  textImages,
  uncoveredImages,
  type ImageRef,
} from "./coverage.js";
import { classifyPackages, parseLockfile } from "./lockfile.js";
import { renderInventory, renderNotice, type GeneratedTable } from "./render.js";
import {
  imageRows,
  npmLockfileRows,
  workspaceRows,
  type ImageReport,
  type Notice,
  type PackageFiles,
  type PnpmReport,
} from "./rows.js";
import { unapprovedRows, type Inventory } from "./source.js";

export interface RepoFiles {
  /** Tracked files, relative to the repository root. */
  readonly tracked: readonly string[];
  read(path: string): string;
  readJson(path: string): unknown;
  pnpmReport(): PnpmReport;
  readonly packageFiles: PackageFiles;
}

export interface Built {
  readonly markdown: string;
  readonly notice: string;
  readonly problems: readonly string[];
  readonly rowCount: number;
}

const DOCKERFILE = /(?:^|\/)Dockerfile(?:\.[\w-]+)?$/;
const SCANNED = [
  /^charts\/.+\.(?:ya?ml|tpl)$/,
  /^dev\/.+\.ya?ml$/,
  /^ci\/.+\.ya?ml$/,
  /^\.github\/workflows\/.+\.ya?ml$/,
  /\.sh$/,
  /(?:^|\/)Tiltfile$/,
];

export function imageRefs(files: Pick<RepoFiles, "tracked" | "read">): ImageRef[] {
  return files.tracked.flatMap((path) => {
    if (DOCKERFILE.test(path)) return dockerfileImages(files.read(path), path);
    if (SCANNED.some((p) => p.test(path))) return textImages(files.read(path), path);
    return [];
  });
}

function coverageProblems(inventory: Inventory, files: RepoFiles): string[] {
  const covered = new Set(inventory.sections.flatMap((s) => s.rows.flatMap((r) => r.images)));
  const uncovered = uncoveredImages(imageRefs(files), covered).map(
    (r) => `image ${r.ref} (${r.at}) has no inventory row: add one with images: [${r.repository}]`,
  );
  const drift = chartValueDrift(
    chartValueKeys(files.read("charts/kobe/values.yaml")),
    inventory.chartValues,
  );
  return [
    ...uncovered,
    ...drift.missing.map(
      (k) => `charts/kobe/values.yaml key "${k}" is not in chartValues (first-party or row ids)`,
    ),
    ...drift.stale.map((k) => `chartValues.${k} names a key charts/kobe/values.yaml no longer has`),
  ];
}

export function buildInventory(inventory: Inventory, files: RepoFiles): Built {
  const problems: string[] = [];
  const notices: Notice[] = [];
  const npmExceptions = files.readJson(inventory.npm.exceptions) as LicenseExceptions;
  const packages = classifyPackages(
    parseLockfile(files.read("pnpm-lock.yaml")),
    Object.keys(inventory.npm.deployables),
  );
  const workspace = workspaceRows(
    packages,
    files.pnpmReport(),
    inventory,
    npmExceptions,
    files.packageFiles,
  );
  problems.push(...workspace.problems);
  notices.push(...workspace.notices);
  const generated: GeneratedTable[] = [
    {
      title: inventory.npm.title,
      intro: inventory.npm.intro,
      rows: workspace.rows,
      exceptionsPath: inventory.npm.exceptions,
      exceptions: npmExceptions,
    },
  ];
  for (const source of inventory.imageReports) {
    const exceptions = files.readJson(source.exceptions) as LicenseExceptions;
    const image = imageRows(files.readJson(source.report) as ImageReport, source, exceptions);
    problems.push(...image.problems);
    notices.push(...image.notices);
    generated.push({
      title: source.title,
      intro: source.intro,
      rows: image.rows,
      exceptionsPath: source.exceptions,
      exceptions,
    });
  }
  const appended: Record<string, GeneratedTable[]> = {};
  for (const source of inventory.npmLockfiles) {
    const lock = npmLockfileRows(files.readJson(source.path) as never, source);
    problems.push(...lock.problems);
    appended[source.section] = [
      ...(appended[source.section] ?? []),
      { title: source.title, intro: `From \`${source.path}\`.`, rows: lock.rows },
    ];
  }
  problems.push(...unapprovedRows(inventory), ...coverageProblems(inventory, files));
  const rowCount =
    generated.reduce((n, t) => n + t.rows.length, 0) +
    Object.values(appended)
      .flat()
      .reduce((n, t) => n + t.rows.length, 0) +
    inventory.sections.reduce((n, s) => n + s.rows.length, 0);
  return {
    markdown: renderInventory({ generated, sections: inventory.sections, appended }),
    notice: renderNotice(inventory.notice, notices),
    problems,
    rowCount,
  };
}
