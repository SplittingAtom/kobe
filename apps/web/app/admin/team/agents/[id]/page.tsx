import { AgentBuilderPage } from "../../../../../components/admin/team/agent-builder/agent-builder-page";

export default async function Page({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AgentBuilderPage agentId={id} />;
}
