/**
 * The Skills page's tabs (KOBE-321, spec SK9), in order, and the `?tab=` reading. A plain module:
 * the page's server component calls `skillTab`, so it must not live in a "use client" file (a
 * client module's functions are only references on the server; calling one throws, review B1).
 */
export const SKILL_TABS = ["catalog", "team", "mine", "workbench"] as const;
export type SkillTab = (typeof SKILL_TABS)[number];

/** The tab a `?tab=` value names; Team when it names none. */
export function skillTab(value: string | string[] | undefined): SkillTab {
  const v = Array.isArray(value) ? value[0] : value;
  return (SKILL_TABS as readonly string[]).includes(v ?? "") ? (v as SkillTab) : "team";
}
