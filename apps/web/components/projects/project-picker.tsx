"use client";

import { useMemo } from "react";
import type { Project } from "../../lib/projects/api";
import { useResource } from "../admin/use-resource";
import { useProjectsApi } from "./use-projects";

/**
 * Chooses whose memory to open: yours, or a project's. Only projects you are a member of are
 * offered (a team admin who is not a member gets nothing from the memory API). If the project
 * list cannot be loaded the picker stays out of the way and your own memory still works.
 */
export function ProjectPicker({
  value,
  onChange,
}: {
  readonly value: string | null;
  readonly onChange: (projectId: string | null) => void;
}) {
  const api = useProjectsApi();
  const { state } = useResource(() => api.list(true));
  const projects: readonly Project[] = useMemo(
    () => (state.status === "ready" ? state.data.filter((p) => p.myRole !== null) : []),
    [state],
  );
  if (state.status !== "ready" || (projects.length === 0 && value === null)) return null;
  return (
    <p>
      <label>
        Memory of{" "}
        <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">Me</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.archivedAt !== null ? " (archived)" : ""}
            </option>
          ))}
          {value !== null && !projects.some((p) => p.id === value) && (
            <option value={value}>This project</option>
          )}
        </select>
      </label>
    </p>
  );
}
