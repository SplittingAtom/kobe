"use client";

import { useState } from "react";
import { isUuid } from "../../lib/memory/ids";
import type { MemoryTarget } from "../../lib/memory/api";
import { useTeamAccess } from "../admin/console-context";
import { MemoryPanel } from "../memory/memory-panel";
import { ProjectPicker } from "../projects/project-picker";

/** `?project=<uuid>` opens that project's memory instead of the person's own. */
function projectFromLocation(): string | null {
  const project = new URLSearchParams(window.location.search).get("project");
  return project !== null && isUuid(project) ? project : null;
}

/** Keeps the address in step with the picker, so a link or a refresh reopens the same memory. */
function showInUrl(projectId: string | null): void {
  const url = new URL(window.location.href);
  if (projectId === null) url.searchParams.delete("project");
  else url.searchParams.set("project", projectId);
  window.history.replaceState(null, "", url);
}

/** The member's memory panel (KOBE-158; API KOBE-155) with a project picker (KOBE-164). */
export function MyMemoryPage() {
  const teamId = useTeamAccess().team.id;
  const [projectId, setProjectId] = useState(projectFromLocation);
  const target: MemoryTarget =
    projectId === null ? { scope: "user" } : { scope: "project", projectId };
  return (
    <>
      <ProjectPicker
        value={projectId}
        onChange={(id) => {
          showInUrl(id);
          setProjectId(id);
        }}
      />
      <MemoryPanel key={projectId ?? "me"} teamId={teamId} target={target} />
    </>
  );
}
