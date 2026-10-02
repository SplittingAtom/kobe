import type { ConsoleSection } from "../../lib/admin/nav/types";

/** A section whose API another ticket builds. That ticket adds the page and flips the entry. */
export function SectionPlaceholder({ section }: { readonly section: ConsoleSection }) {
  if (section.status.kind !== "placeholder") return null;
  return (
    <>
      <h1>{section.label}</h1>
      <p>{section.description}</p>
      <p role="note">Coming in {section.status.ticket}.</p>
    </>
  );
}
