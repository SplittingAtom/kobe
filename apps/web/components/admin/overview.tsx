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
import { PageHeader, Section } from "../ui/console";
import { ConsoleAccessContext } from "./console-context";

/** The console landing page: every section the caller can open, with what it is for. */
export function ConsoleOverview({ kind }: { readonly kind: ConsoleKind }) {
  const access = useContext(ConsoleAccessContext);
  if (access?.console !== kind) return null;
  return (
    <>
      <PageHeader title={CONSOLE_TITLES[kind]} />
      {groupSections(visibleSections(access)).map(({ group, sections }) => (
        <Section key={group} title={group}>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3 p-0">
            {sections.map((s) => (
              <li
                key={s.id}
                className="box-border rounded-lg border border-console-border bg-console-bg p-3"
              >
                <Link href={sectionHref(s)} className="font-medium">
                  {s.label}
                </Link>
                <p className="m-0 mt-1">{s.description}</p>
                {s.status.kind === "placeholder" && (
                  <p className="m-0 mt-1 text-sm text-console-muted">
                    {s.status.onHold ? "On hold" : "Coming in"} {s.status.ticket}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Section>
      ))}
    </>
  );
}
