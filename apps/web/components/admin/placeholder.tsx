import type { ConsoleSection } from "../../lib/admin/nav/types";
import { Notice, PageHeader } from "../ui/console";

/** A section whose API another ticket builds. That ticket adds the page and flips the entry. */
export function SectionPlaceholder({ section }: { readonly section: ConsoleSection }) {
  if (section.status.kind !== "placeholder") return null;
  return (
    <>
      <PageHeader title={section.label} description={section.description} />
      <Notice role="note">Coming in {section.status.ticket}.</Notice>
    </>
  );
}
