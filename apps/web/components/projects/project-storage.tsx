"use client";

import type { Project } from "../../lib/projects/api";
import { bytesOrDash, countOrDash } from "../../lib/projects/storage";
import { Section } from "../ui/console";

/** The project's storage (GV2): live and history, bytes and objects; "—" until counted. */
export function ProjectStorage({ project }: { readonly project: Project }) {
  const rows: readonly (readonly [string, string])[] = [
    ["Live bytes", bytesOrDash(project.liveBytes)],
    ["History bytes", bytesOrDash(project.historyBytes)],
    ["Live objects", countOrDash(project.liveObjects)],
    ["History objects", countOrDash(project.historyObjects)],
  ];
  return (
    <Section
      title="Storage"
      level={3}
      description="Counted against the workspace's storage quota and object budget. History is what only older commits hold."
    >
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-console-muted">{label}</dt>
            <dd className="m-0 tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}
