/**
 * The member's own area (`/my/...`): pages that need no admin permission, only the active team.
 * One entry per page, one line each, so tickets that add a page (KOBE-97: My agents) merge cleanly.
 */
export interface MySection {
  readonly id: string;
  readonly label: string;
  readonly href: string;
}

export const MY_SECTIONS: readonly MySection[] = [
  { id: "skills", label: "My skills", href: "/my/skills" },
];

/** The section a path belongs to (`/my/skills/new` belongs to skills), or null. */
export function mySectionForPath(pathname: string): MySection | null {
  return MY_SECTIONS.find((s) => pathname === s.href || pathname.startsWith(`${s.href}/`)) ?? null;
}
