/** The admin console registry: which sections exist, who sees them, and in what order. */
import * as siteModules from "./site";
import * as teamModules from "./team";
import {
  SITE_GROUPS,
  TEAM_GROUPS,
  type ConsoleAccess,
  type ConsoleKind,
  type ConsoleSection,
  type SiteRole,
  type SiteSection,
  type TeamSection,
} from "./types";

import { consoleHref } from "./paths";

export { CONSOLE_BASE, CONSOLE_SEGMENTS, consoleHref } from "./paths";

export const CONSOLE_TITLES: Readonly<Record<ConsoleKind, string>> = {
  site: "Site console",
  team: "Team console",
};

const GROUPS: Readonly<Record<ConsoleKind, readonly string[]>> = {
  site: SITE_GROUPS,
  team: TEAM_GROUPS,
};

const SEGMENT = /^[a-z][a-z0-9-]{0,39}$/;

function sorted<T extends ConsoleSection>(sections: readonly T[]): readonly T[] {
  return [...sections].sort((a, b) => {
    const group = GROUPS[a.console].indexOf(a.group) - GROUPS[b.console].indexOf(b.group);
    return group || a.order - b.order || a.label.localeCompare(b.label);
  });
}

export const SITE_SECTIONS: readonly SiteSection[] = sorted(Object.values(siteModules));
export const TEAM_SECTIONS: readonly TeamSection[] = sorted(Object.values(teamModules));

export function sectionsOf(kind: ConsoleKind): readonly ConsoleSection[] {
  return kind === "site" ? SITE_SECTIONS : TEAM_SECTIONS;
}

/** Mistakes a new entry can make (duplicate id, bad segment, wrong console); empty when valid. */
export function sectionProblems(kind: ConsoleKind, sections: readonly ConsoleSection[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const s of sections) {
    if (s.console !== kind) problems.push(`${s.id}: listed in the ${kind} console`);
    if (!SEGMENT.test(s.id)) problems.push(`${s.id}: id must be a lowercase URL segment`);
    if (seen.has(s.id)) problems.push(`${s.id}: duplicate id`);
    if (!Number.isFinite(s.order)) problems.push(`${s.id}: order must be a number`);
    if (s.label.trim() === "" || s.description.trim() === "") {
      problems.push(`${s.id}: needs a label and a description`);
    }
    seen.add(s.id);
  }
  return problems;
}

export function findSection(kind: ConsoleKind, id: string): ConsoleSection | undefined {
  return sectionsOf(kind).find((s) => s.id === id);
}

export function sectionHref(section: ConsoleSection): string {
  return `${consoleHref(section.console)}/${section.id}`;
}

const SITE_RANK: Readonly<Record<SiteRole, number>> = { user: 0, admin: 1, owner: 2 };

/** Whether `access` may open `section`. Presentation only: the section's API decides. */
export function canSee(section: ConsoleSection, access: ConsoleAccess): boolean {
  if (section.console === "site") {
    return access.console === "site" && SITE_RANK[access.siteRole] >= SITE_RANK[section.minRole];
  }
  return access.console === "team" && access.permissions.includes(section.permission);
}

export function visibleSections(access: ConsoleAccess): readonly ConsoleSection[] {
  return sectionsOf(access.console).filter((s) => canSee(s, access));
}

/** A console is open to someone who can see at least one of its sections. */
export function canOpenConsole(access: ConsoleAccess): boolean {
  return visibleSections(access).length > 0;
}

export interface SectionGroup {
  readonly group: string;
  readonly sections: readonly ConsoleSection[];
}

/** Sections grouped for the side navigation, in group order, empty groups dropped. */
export function groupSections(sections: readonly ConsoleSection[]): readonly SectionGroup[] {
  const groups: SectionGroup[] = [];
  for (const section of sections) {
    const last = groups.at(-1);
    if (last?.group === section.group) {
      groups[groups.length - 1] = { group: last.group, sections: [...last.sections, section] };
    } else {
      groups.push({ group: section.group, sections: [section] });
    }
  }
  return groups;
}

/** The section a pathname belongs to: `/admin/team/members/x` → members; the overview → null. */
export function sectionForPath(kind: ConsoleKind, pathname: string): ConsoleSection | null {
  const prefix = `${consoleHref(kind)}/`;
  if (!pathname.startsWith(prefix)) return null;
  const id = pathname.slice(prefix.length).split("/")[0] ?? "";
  return findSection(kind, id) ?? null;
}
