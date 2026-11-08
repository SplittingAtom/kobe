/**
 * Add to project helpers (KOBE-585): pure functions behind the dialog in
 * `components/projects/add-to-project.tsx`.
 */
import { artifactFileExtension, artifactFileStem, type ArtifactKind } from "@kobe/protocol";
import { ancestorsOf, joinPath } from "../files/tree";
import type { Project, ProjectFile } from "./api";

/** The server's default name for an artifact: its stem and extension (`@kobe/protocol`). */
export function artifactProjectFileName(
  title: string,
  kind: ArtifactKind,
  language: string | null,
): string {
  return `${artifactFileStem(title)}.${artifactFileExtension(kind, language)}`;
}

/** `plan.md` -> `plan-2.md`; `README` -> `README-2`; `.env` -> `.env-2` ("Add as copy"). */
export function numberedName(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name}-${n}`;
  return `${name.slice(0, dot)}-${n}${name.slice(dot)}`;
}

/** Every folder the project's files sit in (with their parents), sorted; root is "". */
export function projectFolders(files: readonly Pick<ProjectFile, "path">[]): string[] {
  return [...new Set(files.flatMap((f) => ancestorsOf(f.path)))].sort();
}

/** The most numbered names "Add as copy" looks through. */
export const COPY_NAME_MAX = 1000;

/**
 * The first `name-2`, `name-3` … not taken in `folder` (paths inside the project), or undefined
 * when every one up to {@link COPY_NAME_MAX} is.
 */
export function firstFreeName(
  name: string,
  folder: string,
  taken: ReadonlySet<string>,
): string | undefined {
  for (let n = 2; n <= COPY_NAME_MAX; n += 1) {
    const candidate = numberedName(name, n);
    if (!taken.has(joinPath(folder, candidate))) return candidate;
  }
  return undefined;
}

/**
 * Projects the content's owner may add to: the list holds the projects the caller is a member of
 * (and every project for a team admin), so each one passes `canAddToProject(…, true)`; archived
 * projects take no files.
 */
export function addableProjects(projects: readonly Project[]): Project[] {
  return projects.filter((p) => p.archivedAt === null);
}

/** Where every member finds the file: `projects/<slug>/<path>`. */
export const mountedPath = (slug: string, path: string): string => `projects/${slug}/${path}`;
