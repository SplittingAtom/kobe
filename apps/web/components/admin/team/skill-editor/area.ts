import type { SkillScope } from "../../../../lib/admin/api/team/skills";

/** Where the skill pages run: the team console, or the member's own area (KOBE-98). */
export type SkillArea = "team" | "my";

export interface SkillPaths {
  readonly base: string;
  readonly listTitle: string;
  readonly backLabel: string;
  /** Scope a list asks for (undefined: everything the caller can see). */
  readonly listScope: SkillScope | undefined;
  /** Scope a new skill starts with. */
  readonly newScope: SkillScope;
}

const PATHS: Readonly<Record<SkillArea, SkillPaths>> = {
  team: {
    base: "/admin/team/skills",
    listTitle: "Skills",
    backLabel: "All skills",
    listScope: undefined,
    newScope: "team",
  },
  my: {
    base: "/my/skills",
    listTitle: "My skills",
    backLabel: "My skills",
    listScope: "personal",
    newScope: "personal",
  },
};

export function skillPaths(area: SkillArea): SkillPaths {
  return PATHS[area];
}
