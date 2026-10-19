import { DraftEditorPage } from "../../../../../components/skills/draft-editor-page";

/** One Workbench draft's editor (KOBE-321, SK12). */
export default async function Page({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DraftEditorPage draftId={id} />;
}
