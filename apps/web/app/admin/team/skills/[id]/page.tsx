import { SkillAdminPage } from "../../../../../components/admin/team/skill-editor/skill-admin-page";

export default async function Page({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SkillAdminPage skillId={id} />;
}
