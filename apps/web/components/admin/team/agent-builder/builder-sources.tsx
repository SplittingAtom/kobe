"use client";

import { createContext, useContext } from "react";
import type { ApiResult } from "../../../../lib/api/client";
import { listTeamConnectors, type TeamConnector } from "../../../../lib/admin/api/team/connectors";
import { listTeamModels, type TeamModels } from "../../../../lib/admin/api/team/models";
import { getSkillChoices, type SkillChoices } from "../../../../lib/admin/api/team/skill-choices";
import { ConsoleAccessContext } from "../../console-context";

/**
 * Where the creator's Behaviour tab gets its choices (KOBE-494): the active team's models,
 * connectors and skills in the team console and My Agents; the site's own when a site admin edits
 * a gallery agent (`GalleryBuilderSources`). The server decides what is allowed either way.
 */
export interface BuilderSources {
  readonly models: () => Promise<ApiResult<TeamModels>>;
  readonly connectors: () => Promise<ApiResult<readonly TeamConnector[]>>;
  readonly skills: () => Promise<ApiResult<SkillChoices>>;
  /** Whether the Dangerous approval mode is offered (AC1); the server enforces it. */
  readonly mayDangerous: boolean;
  /** Who "the default" model and approval mode belong to, in hints ("team"). */
  readonly modelsHint: string;
}

export const BuilderSourcesContext = createContext<BuilderSources | null>(null);

/** The given sources, else the active team's (outside both: an error, as before). */
export function useBuilderSources(): BuilderSources {
  const given = useContext(BuilderSourcesContext);
  const access = useContext(ConsoleAccessContext);
  if (given) return given;
  if (access?.console !== "team") throw new Error("useTeamAccess outside the team console");
  const teamId = access.team.id;
  return {
    models: () => listTeamModels(teamId),
    connectors: () => listTeamConnectors(teamId),
    skills: () => getSkillChoices(teamId),
    // Who may choose Dangerous (AC1): team admins and site admins.
    mayDangerous: access.role === "team_admin" || access.siteAdmin === true,
    modelsHint: "Models the team has enabled.",
  };
}
