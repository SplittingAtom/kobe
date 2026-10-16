import { AgentBuilderPage } from "../../../../../components/admin/team/agent-builder/agent-builder-page";

export default async function Page({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<{ addSkill?: string | string[] }>;
}) {
  const { id } = await params;
  const { addSkill } = await searchParams;
  // A skill page's "Add to agent…" (KOBE-297); the builder checks the name.
  return (
    <AgentBuilderPage agentId={id} addSkill={typeof addSkill === "string" ? addSkill : undefined} />
  );
}
