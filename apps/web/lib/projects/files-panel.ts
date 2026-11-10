/**
 * The Files panel's project list (Projects in conversations FP1-FP5; KOBE-590), pure: every
 * non-archived project as a row (mounted or not), the active one first, the greyed rest, the
 * head listing of a project that is not mounted, the scale rules and the drag refusal's words.
 */
import type { FileEntry } from "../files/api";
import { joinPath } from "../files/tree";
import type { TreeRow } from "../files/tree";
import type { Project, ProjectFile } from "./api";
import { PROJECTS_FOLDER } from "./workspace";

/** Above this many projects the list is capped (FP5). */
export const PROJECTS_CAP = 50;
/** From this many projects a filter field shows above the list (FP5). */
export const PROJECTS_FILTER_AT = 20;

export const ACTIVE_LABEL = "Active in this conversation";
export const NOT_IN_CONVERSATION = "Not in this conversation";

export const unmountedDragRefusal = (projectName: string): string =>
  `Start a conversation in ${projectName} to mention its files`;

/** The mount path a project would have (`projects/<slug>`), for rows of projects not mounted. */
export const projectFolderPath = (slug: string): string => joinPath(PROJECTS_FOLDER, slug);

/** A project's row when it is not mounted in the member's files (listed from its head). */
export function unmountedProjectEntry(project: Pick<Project, "slug" | "updatedAt">): FileEntry {
  return {
    name: project.slug,
    path: projectFolderPath(project.slug),
    type: "dir",
    sizeBytes: null,
    mtime: project.updatedAt,
    source: "synced",
    area: "projects",
  };
}

/**
 * One folder of a project's head, from its flat file list (`GET /v1/projects/:id/files`):
 * `folder` is relative to the project ("" = its top), entries carry mount-style paths.
 */
export function headListing(
  files: readonly ProjectFile[],
  slug: string,
  folder: string,
): readonly FileEntry[] {
  const base = projectFolderPath(slug);
  const prefix = folder === "" ? "" : `${folder}/`;
  const out = new Map<string, FileEntry>();
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    const rest = file.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    const name = slash === -1 ? rest : rest.slice(0, slash);
    if (name === "" || out.has(name)) continue;
    out.set(name, {
      name,
      path: joinPath(base, joinPath(folder, name)),
      type: slash === -1 ? "file" : "dir",
      sizeBytes: slash === -1 ? file.sizeBytes : null,
      mtime: file.addedAt,
      source: "synced",
      area: "projects",
    });
  }
  return [...out.values()].sort(
    (a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name),
  );
}

export interface ShapeInput {
  /** Display name by slug. */
  readonly projects: ReadonlyMap<string, Project>;
  /** The active project's slug, or undefined. */
  readonly activeSlug: string | undefined;
  readonly checkedOut: ReadonlySet<string>;
  readonly filter: string;
  readonly showAll: boolean;
}

export interface Shaped {
  readonly rows: readonly TreeRow[];
  /** Non-archived projects in all. */
  readonly total: number;
  /** Projects hidden by the cap (0 when none, or when everything shows). */
  readonly hidden: number;
}

const slugOfRow = (row: TreeRow): string | undefined => {
  const path = row.kind === "entry" ? row.entry.path : row.folder;
  const [root, slug] = path.split("/", 2);
  return root === PROJECTS_FOLDER ? slug : undefined;
};

/**
 * Orders (active first, then by name), filters and caps (FP5) the project rows. `rows` are the
 * Projects tree's rows (a project is level 1) with each expanded project's rows after it.
 */
export function shapeProjectRows(rows: readonly TreeRow[], input: ShapeInput): Shaped {
  const groups = new Map<string, TreeRow[]>();
  for (const row of rows) {
    const slug = slugOfRow(row);
    if (slug === undefined) continue;
    if (row.kind === "entry" && row.level === 1) groups.set(slug, [row]);
    else groups.get(slug)?.push(row);
  }
  const live = [...groups.keys()].filter(
    (slug) => (input.projects.get(slug)?.archivedAt ?? null) === null,
  );
  const nameOf = (slug: string) => input.projects.get(slug)?.name ?? slug;
  const needle = input.filter.trim().toLowerCase();
  let shown = live.filter(
    (slug) =>
      needle === "" ||
      nameOf(slug).toLowerCase().includes(needle) ||
      slug.toLowerCase().includes(needle),
  );
  let hidden = 0;
  if (needle === "" && !input.showAll && live.length > PROJECTS_CAP) {
    const recent = [...live]
      .sort((a, b) =>
        (input.projects.get(b)?.updatedAt ?? "").localeCompare(
          input.projects.get(a)?.updatedAt ?? "",
        ),
      )
      .slice(0, PROJECTS_CAP);
    const keep = new Set([
      ...recent,
      ...live.filter((s) => s === input.activeSlug || input.checkedOut.has(s)),
    ]);
    shown = shown.filter((s) => keep.has(s));
    hidden = live.length - shown.length;
  }
  shown.sort(
    (a, b) =>
      Number(b === input.activeSlug) - Number(a === input.activeSlug) ||
      nameOf(a).localeCompare(nameOf(b)),
  );
  const out: TreeRow[] = [];
  shown.forEach((slug, i) => {
    for (const row of groups.get(slug) ?? []) {
      if (row.kind === "entry" && row.level === 1) {
        out.push({ ...row, posinset: i + 1, setsize: shown.length });
      } else out.push(row);
    }
  });
  return { rows: out, total: live.length, hidden };
}
