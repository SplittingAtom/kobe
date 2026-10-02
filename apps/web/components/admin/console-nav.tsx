"use client";

import Link from "next/link";
import { useState } from "react";
import { CONSOLE_TITLES, groupSections, sectionHref } from "../../lib/admin/nav/registry";
import type { ConsoleKind, ConsoleSection } from "../../lib/admin/nav/types";
import styles from "./admin.module.css";

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
  // Narrow screens fold the list behind a toggle so the page comes first; wide screens show it.
  const [open, setOpen] = useState(false);
  const listId = `console-nav-${kind}`;
  return (
    <nav aria-label={`${CONSOLE_TITLES[kind]} sections`} className={styles.nav}>
      <button
        type="button"
        className={styles.navToggle}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
      >
        {current ? `Section: ${current.label}` : "Sections"}
      </button>
      <div id={listId} className={open ? styles.navList : `${styles.navList} ${styles.navFolded}`}>
        {groupSections(sections).map(({ group, sections: inGroup }) => (
          <div key={group} className={styles.navGroup}>
            <h2 id={`nav-${kind}-${slug(group)}`} className={styles.navHeading}>
              {group}
            </h2>
            <ul aria-labelledby={`nav-${kind}-${slug(group)}`}>
              {inGroup.map((s) => (
                <li key={s.id}>
                  <Link
                    href={sectionHref(s)}
                    onClick={() => setOpen(false)}
                    aria-current={current?.id === s.id ? "page" : undefined}
                    className={styles.navLink}
                  >
                    {s.label}
                    {s.status.kind === "placeholder" && (
                      <span className={styles.soon}>
                        {" "}
                        <span aria-hidden="true">·</span> soon
                        <span className={styles.visuallyHidden}>, coming in {s.status.ticket}</span>
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
