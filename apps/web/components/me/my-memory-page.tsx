"use client";

import { useState } from "react";
import { isUuid } from "../../lib/memory/ids";
import type { MemoryTarget } from "../../lib/memory/api";
import { useTeamAccess } from "../admin/console-context";
import { MemoryPanel } from "../memory/memory-panel";

/** `?project=<uuid>` opens that project's memory instead of the person's own. */
function targetFromLocation(): MemoryTarget {
  const project = new URLSearchParams(window.location.search).get("project");
  return project !== null && isUuid(project)
    ? { scope: "project", projectId: project }
    : { scope: "user" };
}

/** The member's memory panel (KOBE-158; API KOBE-155). Any member of the team may open it. */
export function MyMemoryPage() {
  const teamId = useTeamAccess().team.id;
  const [target] = useState(targetFromLocation);
  return <MemoryPanel teamId={teamId} target={target} />;
}
