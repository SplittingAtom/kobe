import type { TeamRole } from "@kobe/db";
import { teamRoleAllows } from "../authz/permissions.js";

/**
 * Who may do what with an agent definition (spec D6, D8, D9, D19). Pure, so routes and tests
 * share one rulebook. The caller is a member of the active team with `role`.
 */

export type AgentScope = "personal" | "team" | "gallery";
/** Scopes a team member can create into; gallery agents are created by install admins. */
export type CreatableScope = Exclude<AgentScope, "gallery">;

export interface AgentRef {
  readonly scope: AgentScope;
  readonly ownerUserId: string | null;
}

export interface AgentActor {
  readonly userId: string;
  readonly role: TeamRole;
}

export interface AgentAccess {
  /** Listed and shown as a summary (name, description, icon, starters). */
  readonly see: boolean;
  /** Full definition (frontmatter + prompt) and export. */
  readonly readDefinition: boolean;
  /** Replace the draft, delete (or archive) the agent, unarchive it. */
  readonly edit: boolean;
  /** Publish the draft as a new version, or roll back to an older one (KOBE-46). */
  readonly publish: boolean;
  /** Suspend or reactivate (team agents, team admins). */
  readonly setStatus: boolean;
}

const NONE: AgentAccess = {
  see: false,
  readDefinition: false,
  edit: false,
  publish: false,
  setStatus: false,
};

export function agentAccess(actor: AgentActor, agent: AgentRef): AgentAccess {
  const { role } = actor;
  switch (agent.scope) {
    case "team": {
      const builder = teamRoleAllows(role, "team.agents.build");
      const mine = agent.ownerUserId === actor.userId || teamRoleAllows(role, "team.agents.manage");
      return {
        see: teamRoleAllows(role, "team.agents.use"),
        readDefinition: builder,
        edit: builder && mine,
        // D8: builders publish (their own agents), team admins publish any team agent.
        publish: teamRoleAllows(role, "team.agents.publish") && mine,
        setStatus: teamRoleAllows(role, "team.agents.suspend"),
      };
    }
    case "personal": {
      // Someone else's personal agent does not exist as far as the caller is concerned.
      if (agent.ownerUserId !== actor.userId) return NONE;
      const own = teamRoleAllows(role, "team.personal.create");
      return { see: true, readDefinition: true, edit: own, publish: own, setStatus: false };
    }
    case "gallery": {
      // Install-wide, admin-curated and read-only to teams; teams fork (D19).
      const use = teamRoleAllows(role, "team.agents.use");
      return { see: use, readDefinition: use, edit: false, publish: false, setStatus: false };
    }
  }
}

export function canCreateAgent(role: TeamRole, scope: CreatableScope): boolean {
  return teamRoleAllows(role, scope === "team" ? "team.agents.build" : "team.personal.create");
}

/**
 * Forking copies a definition into a new team or personal agent. Team agents never fork into
 * personal scope: personal agents follow the user into other teams (D9), so that would carry one
 * team's content into another ("teams are walls"). Exporting a file stays a deliberate human act.
 */
export function canForkAgent(actor: AgentActor, source: AgentRef, target: CreatableScope): boolean {
  if (source.scope === "team" && target === "personal") return false;
  return agentAccess(actor, source).readDefinition && canCreateAgent(actor.role, target);
}

/** Install admins curating the gallery (install.gallery.manage) hold every right on it. */
export const GALLERY_ADMIN_ACCESS: AgentAccess = {
  see: true,
  readDefinition: true,
  edit: true,
  publish: true,
  setStatus: true,
};
