"use client";

import { useMemo } from "react";
import { listTeamMembers, type TeamMember } from "../../lib/admin/api/team/members";
import { createProjectsApi, type ProjectAgent, type ProjectsApi } from "../../lib/projects/api";
import { useTeamAccess } from "../admin/console-context";
import { useResource, type ResourceState } from "../admin/use-resource";

/** The projects API of the active team. */
export function useProjectsApi(): ProjectsApi {
  const teamId = useTeamAccess().team.id;
  return useMemo(() => createProjectsApi(teamId), [teamId]);
}

/** Team people by id, so member lists show names. Failure only means ids are shown instead. */
export function useRoster(): {
  readonly state: ResourceState<readonly TeamMember[]>;
  readonly nameOf: (userId: string) => string;
} {
  const teamId = useTeamAccess().team.id;
  const { state } = useResource(() => listTeamMembers(teamId));
  const nameOf = (userId: string): string =>
    (state.status === "ready" ? state.data.find((m) => m.userId === userId)?.name : undefined) ??
    `User ${userId.slice(0, 8)}`;
  return { state, nameOf };
}

/** Agents a project can default to; an empty list when they cannot be loaded. */
export function useProjectAgents(api: ProjectsApi): readonly ProjectAgent[] {
  const { state } = useResource(() => api.agents());
  return state.status === "ready" ? state.data : [];
}
