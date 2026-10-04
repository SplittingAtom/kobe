import { SkillEditorPage } from "../../../../components/admin/team/skill-editor/skill-editor-page";

export default async function Page({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SkillEditorPage area="my" skillId={id} />;
}
