import { SkillsPage, skillTab } from "../../../components/skills/skills-page";

/** The Skills page (KOBE-321, SK9); `?tab=` opens Catalog, Team, Mine or Workbench. */
export default async function Page({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { tab } = await searchParams;
  return <SkillsPage initialTab={skillTab(tab)} />;
}
