import { DraftEditorPage } from "../../../../../components/skills/draft-editor-page";
import { draftTabParam } from "../../../../../lib/skills/draft-tabs";

/** One Workbench draft's editor (KOBE-321, SK12); `?tab=` opens Define, Test or Eval (KOBE-459). */
export default async function Page({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const tab = draftTabParam((await searchParams).tab);
  return <DraftEditorPage draftId={id} tab={tab} />;
}
