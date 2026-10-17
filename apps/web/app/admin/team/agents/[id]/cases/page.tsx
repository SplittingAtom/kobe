import { SharedCasesPage } from "../../../../../../components/admin/team/eval-cases/shared-cases-page";

export default async function Page({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SharedCasesPage scope="team" agentId={id} />;
}
