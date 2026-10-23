import { CatalogSkillPage } from "../../../../../components/admin/site/catalog-skill-page";

export default async function Page({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CatalogSkillPage skillId={id} />;
}
