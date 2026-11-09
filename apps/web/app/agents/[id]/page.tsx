import { AgentBuilderPage } from "../../../components/admin/team/agent-builder/agent-builder-page";

export default async function Page({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<{ from?: string | string[] }>;
}) {
  const { id } = await params;
  const { from } = await searchParams;
  // A View opened from the Site tab shows the site roster's version in effect (KOBE-571).
  return (
    <AgentBuilderPage
      scope="personal"
      agentId={id}
      rosterFrom={from === "site" ? "site" : undefined}
    />
  );
}
