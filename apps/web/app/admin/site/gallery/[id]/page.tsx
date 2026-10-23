import { GalleryAgentEditor } from "../../../../../components/admin/site/gallery-agent-editor";

export default async function Page({ params }: { readonly params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <GalleryAgentEditor agentId={id} />;
}
