import { SharedCasePage } from "../../../../../../components/admin/team/eval-cases/shared-case-page";

export default async function Page({
  params,
}: {
  readonly params: Promise<{ id: string; caseId: string }>;
}) {
  const { id, caseId } = await params;
  return <SharedCasePage scope="personal" agentId={id} caseId={caseId} />;
}
