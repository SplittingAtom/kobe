import { CatalogDetailPage } from "../../../../../components/skills/catalog-detail-page";

/** A catalog skill's detail (KOBE-336, SK25). */
export default async function Page({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CatalogDetailPage skillId={id} />;
}
