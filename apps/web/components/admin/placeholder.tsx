import type { ConsoleSection } from "../../lib/admin/nav/types";
import { Notice, PageHeader } from "../ui/console";

/**
 * A section whose API another ticket builds (that ticket adds the page and flips the entry), or
 * one whose ticket is on hold, with why.
 */
export function SectionPlaceholder({ section }: { readonly section: ConsoleSection }) {
  if (section.status.kind !== "placeholder") return null;
  return (
    <>
      <PageHeader title={section.label} description={section.description} />
      {section.status.onHold ? (
        <Notice role="note" title="On hold">
          <p>
            {section.status.onHold} ({section.status.ticket})
          </p>
        </Notice>
      ) : (
        <Notice role="note">Coming in {section.status.ticket}.</Notice>
      )}
    </>
  );
}
