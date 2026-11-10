"use client";

import { useMemo, useRef } from "react";
import type { ApiResult } from "../../lib/api/client";
import type { FilesApi } from "../../lib/files/api";
import type { ProjectFile } from "../../lib/projects/api";
import { headListing } from "../../lib/projects/files-panel";
import { PROJECTS_FOLDER, projectSlugOf } from "../../lib/projects/workspace";
import { useWorkspaceProjects, type WorkspaceProjects } from "../projects/workspace-projects";

/** How long a project's head file list is reused while folders of it open (ms). */
const HEAD_TTL_MS = 10_000;

/**
 * The Files tree's listing API with the projects that are not mounted (KOBE-590, FP4): where the
 * member's own files have no `projects/<slug>` folder, a known project lists from its head
 * (`GET /v1/projects/:id/files`, readers too), read-only and without mounting. A mounted project,
 * and everything outside projects/, is the wrapped API's answer; a missing projects/ folder is an
 * empty one (the Projects section lists every project, mounted or not).
 */
export function useProjectHeads(api: FilesApi): FilesApi {
  const ctx = useWorkspaceProjects();
  const latest = useRef<WorkspaceProjects | null>(ctx);
  latest.current = ctx;
  return useMemo(() => {
    const cache = new Map<
      string,
      { at: number; files: Promise<ApiResult<readonly ProjectFile[]>> }
    >();
    const heads = (id: string, projects: WorkspaceProjects["projects"]) => {
      const hit = cache.get(id);
      if (hit && Date.now() - hit.at < HEAD_TTL_MS) return hit.files;
      const files = projects.files(id);
      cache.set(id, { at: Date.now(), files });
      return files;
    };
    return {
      ...api,
      async list(path, cursor, signal) {
        const real = await api.list(path, cursor, signal);
        const current = latest.current;
        if (real.ok || real.error.status !== 404 || current === null) return real;
        if (path === PROJECTS_FOLDER) return { ok: true, status: 200, data: { path, entries: [] } };
        const slug = projectSlugOf(path);
        const project = slug === undefined ? undefined : current.bySlug.get(slug);
        if (slug === undefined || !project || project.archivedAt !== null) return real;
        const files = await heads(project.id, current.projects);
        if (!files.ok) return { ok: false, error: files.error };
        const inside =
          path === `${PROJECTS_FOLDER}/${slug}`
            ? ""
            : path.slice(PROJECTS_FOLDER.length + slug.length + 2);
        return {
          ok: true,
          status: 200,
          data: { path, entries: headListing(files.data, slug, inside) },
        };
      },
    };
  }, [api]);
}
