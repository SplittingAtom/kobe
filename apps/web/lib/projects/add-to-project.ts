/**
 * Add to project helpers (KOBE-585): pure functions behind the dialog in
 * `components/projects/add-to-project.tsx`.
 */
import { artifactFileExtension, type ArtifactKind } from "@kobe/protocol";
import type { Project, ProjectFile } from "./api";

/** The server's default name for an artifact (`artifacts/serve.ts` fileStem + extension). */
export function artifactProjectFileName(
  title: string,
  kind: ArtifactKind,
  language: string | null,
): string {
  const stem = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return `${stem === "" ? "artifact" : stem}.${artifactFileExtension(kind, language)}`;
}

/** `plan.md` -> `plan-2.md`; `README` -> `README-2`; `.env` -> `.env-2` ("Add as copy"). */
export function numberedName(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name}-${n}`;
  return `${name.slice(0, dot)}-${n}${name.slice(dot)}`;
}

/** Every folder the project's files sit in (with their parents), sorted; root is "". */
export function projectFolders(files: readonly Pick<ProjectFile, "path">[]): string[] {
  const folders = new Set<string>();
  for (const f of files) {
    const parts = f.path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i += 1) folders.add(parts.slice(0, i).join("/"));
  }
  return [...folders].sort();
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
