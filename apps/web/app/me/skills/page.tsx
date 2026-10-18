import { SkillsPage } from "../../../components/skills/skills-page";
import { skillTab } from "../../../lib/skills/tabs";

/** The Skills page (KOBE-321, SK9); `?tab=` opens Catalog, Team, Mine or Workbench. */
export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const tab = skillTab((await searchParams).tab);
  // Keyed by the tab: a link to another ?tab= while on the page opens that tab (review nit).
  return <SkillsPage key={tab} initialTab={tab} />;
}
