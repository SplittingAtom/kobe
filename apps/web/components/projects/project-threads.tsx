"use client";

import Link from "next/link";
import type { ThreadPage } from "../../lib/chat/types";
import type { Project } from "../../lib/projects/api";
import { useTeamAccess } from "../admin/console-context";
import { DateTime, ResourceView } from "../admin/parts";
import type { ResourceState } from "../admin/use-resource";
import { EmptyState, Section } from "../ui/console";
import { useRoster } from "./use-projects";

/** The project's conversations: your own and the ones members shared (opened read-only). */
export function ProjectThreads({
  state,
}: {
  readonly project: Project;
  /** The project's threads, read once by the page (it also tells whether the project is mounted). */
  readonly state: ResourceState<ThreadPage>;
}) {
  const me = useTeamAccess().user.id;
  const roster = useRoster();
  return (
    <Section title="Conversations">
      <ResourceView state={state} label="conversations">
        {(page) =>
          page.threads.length === 0 ? (
            <EmptyState title="No conversations in this project yet." />
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {page.threads.map((t) => (
                <li key={t.threadId}>
                  <Link href={`/?thread=${t.threadId}`}>{t.title ?? "Untitled conversation"}</Link>{" "}
                  <span className="text-sm text-console-muted">
                    {t.ownerUserId === me
                      ? t.visibility === "team"
                        ? "yours, shared with the team"
                        : t.sharedToProject
                          ? "yours, shared with the project"
                          : "yours, private"
                      : `shared by ${roster.nameOf(t.ownerUserId)}, read-only`}
                    {" · "}
                    <DateTime value={t.lastActivityAt} />
                  </span>
                </li>
              ))}
            </ul>
          )
        }
      </ResourceView>
    </Section>
  );
}
