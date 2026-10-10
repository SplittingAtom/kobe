import { ProjectDetailPage } from "../../../../components/projects/project-detail-page";

export default async function Page({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProjectDetailPage projectId={id} />;
}
