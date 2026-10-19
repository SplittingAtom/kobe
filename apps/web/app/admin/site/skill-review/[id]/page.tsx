import { SkillReviewPage } from "../../../../../components/admin/site/skill-review-page";

export default async function Page({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SkillReviewPage versionId={id} />;
}
