import { CatalogSkillEditor } from "../../../../../../components/admin/site/catalog-skill-editor";

export default async function Page({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CatalogSkillEditor skillId={id} />;
}
