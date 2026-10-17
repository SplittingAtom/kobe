"use client";

import { CONSOLE_TITLES, groupSections, sectionHref } from "../../lib/admin/nav/registry";
import type { ConsoleKind, ConsoleSection } from "../../lib/admin/nav/types";
import { SideNav, SideNavGroup, SideNavLink } from "../ui/console";

/** The console's side navigation: grouped sections, the current one marked for assistive tech. */
export function ConsoleNav({
  kind,
  sections,
  current,
}: {
  readonly kind: ConsoleKind;
  readonly sections: readonly ConsoleSection[];
  readonly current: ConsoleSection | null;
}) {
  return (
    <SideNav
      label={`${CONSOLE_TITLES[kind]} sections`}
      toggleLabel={current ? `Section: ${current.label}` : "Sections"}
      listId={`console-nav-${kind}`}
    >
      {groupSections(sections).map(({ group, sections: inGroup }) => (
        <SideNavGroup key={group} id={`nav-${kind}-${slug(group)}`} heading={group}>
          {inGroup.map((s) => (
            <SideNavLink key={s.id} href={sectionHref(s)} current={current?.id === s.id}>
              {s.label}
              {s.status.kind === "placeholder" && (
                <span className="text-[0.85em] text-console-muted">
                  {" "}
                  <span aria-hidden="true">·</span> {s.status.onHold ? "on hold" : "soon"}
                  <span className="sr-only">
                    , {s.status.onHold ? "on hold" : "coming in"} {s.status.ticket}
                  </span>
                </span>
              )}
            </SideNavLink>
          ))}
        </SideNavGroup>
      ))}
    </SideNav>
  );
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
