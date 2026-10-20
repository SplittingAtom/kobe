/**
 * The skill editors the Workbench replaced (KOBE-321, spec SK9): their old links land on the
 * Skills page. `/me/skills/:id` matches one segment only, so `/me/skills/drafts/<id>` (the
 * Workbench editor) is never caught. Free of components, so next.config.ts can import it.
 */
export interface SkillRedirect {
  readonly source: string;
  readonly destination: string;
  readonly permanent: boolean;
}

export const SKILLS_PAGE = "/me/skills";

export function skillEditorRedirects(): SkillRedirect[] {
  return [
    { source: "/me/skills/new", destination: `${SKILLS_PAGE}?tab=workbench`, permanent: true },
    {
      source: "/admin/team/skills/new",
      destination: `${SKILLS_PAGE}?tab=workbench`,
      permanent: true,
    },
    // The Skills panel's short address (KOBE-452 names it `/skills`).
    { source: "/skills", destination: SKILLS_PAGE, permanent: false },
    { source: "/skills/:path*", destination: `${SKILLS_PAGE}/:path*`, permanent: false },
    // Not permanent (no cached 308): a later /me/skills/<slug> page (C7) must stay possible.
    { source: "/me/skills/:id", destination: `${SKILLS_PAGE}?tab=mine`, permanent: false },
  ];
}
