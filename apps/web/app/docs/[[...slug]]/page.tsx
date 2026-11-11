import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GuideView } from "../../../components/docs/guide-view";
import { pageBySlug } from "../../../lib/docs/guide";
import { getSiteBranding } from "../../../lib/theme/branding-server";

type Props = { readonly params: Promise<{ slug?: string[] }> };

function slugOf(parts: readonly string[] | undefined): string | null {
  return parts && parts.length > 0 ? parts.map((s) => decodeURIComponent(s)).join("/") : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const slug = slugOf((await params).slug);
  const page = slug === null ? null : pageBySlug(slug);
  return page === null ? { title: "Docs" } : { title: page.title, description: page.summary };
}

/** /docs (sections and pages) and /docs/<slug> (one page), from the guide in the bundle. */
export default async function DocsPage({ params }: Props) {
  const slug = slugOf((await params).slug);
  const page = slug === null ? null : pageBySlug(slug);
  if (slug !== null && page === null) notFound();
  const { appName } = await getSiteBranding();
  return <GuideView page={page} appName={appName} />;
}
