"use client";

import { useMemo } from "react";
import type { Project } from "../../lib/projects/api";
import { useResource } from "../admin/use-resource";
import { Field, Select } from "../ui/console";
import { useProjectsApi } from "./use-projects";

/**
 * Chooses whose memory to open: yours, or a project's. Every project of the workspace is offered
 * (every member reads every project's memory, KOBE-587; team admins act as owners). If the project
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
    () => (state.status === "ready" ? state.data : []),
    [state],
  );
  if (state.status !== "ready" || (projects.length === 0 && value === null)) return null;
  return (
    <Field label="Memory of" className="mb-4 w-fit">
      <Select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
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
      </Select>
    </Field>
  );
}
