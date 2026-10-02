"use client";

import Link from "next/link";
import { useContext } from "react";
import {
  CONSOLE_TITLES,
  groupSections,
  sectionHref,
  visibleSections,
} from "../../lib/admin/nav/registry";
import type { ConsoleKind } from "../../lib/admin/nav/types";
import { ConsoleAccessContext } from "./console-context";
import styles from "./admin.module.css";

/** The console landing page: every section the caller can open, with what it is for. */
export function ConsoleOverview({ kind }: { readonly kind: ConsoleKind }) {
  const access = useContext(ConsoleAccessContext);
  if (access?.console !== kind) return null;
  return (
    <>
      <h1>{CONSOLE_TITLES[kind]}</h1>
      {groupSections(visibleSections(access)).map(({ group, sections }) => (
        <section key={group} aria-label={group}>
          <h2>{group}</h2>
          <ul className={styles.cards}>
            {sections.map((s) => (
              <li key={s.id} className={styles.card}>
                <Link href={sectionHref(s)}>{s.label}</Link>
                <p>{s.description}</p>
                {s.status.kind === "placeholder" && (
                  <p className={styles.soon}>Coming in {s.status.ticket}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
