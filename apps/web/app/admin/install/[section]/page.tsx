import { notFound } from "next/navigation";
import { SectionPlaceholder } from "../../../../components/admin/placeholder";
import { findSection } from "../../../../lib/admin/nav/registry";

/**
 * Sections registered as `comingIn("KOBE-xx")`. A ticket that builds one adds its own
 * `app/admin/install/<id>/page.tsx` (a static route wins over this one) and marks the entry READY.
 */
export default async function InstallSectionPlaceholder({
  params,
}: {
  readonly params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  const entry = findSection("install", section);
  if (!entry || entry.status.kind !== "placeholder") notFound();
  return <SectionPlaceholder section={entry} />;
}
