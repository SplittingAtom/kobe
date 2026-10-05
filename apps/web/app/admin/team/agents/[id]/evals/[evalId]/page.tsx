import { EvalReportPage } from "../../../../../../../components/admin/team/agent-builder/eval-report";

export default async function Page({
  params,
}: {
  readonly params: Promise<{ id: string; evalId: string }>;
}) {
  const { id, evalId } = await params;
  return <EvalReportPage agentId={id} evalId={evalId} />;
}
