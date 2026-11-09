"use client";

import type { Project } from "../../lib/projects/api";
import { DateTime, ResourceView } from "../admin/parts";
import { useResource } from "../admin/use-resource";
import {
  EmptyState,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "../ui/console";
import { useCommitsApi, useRoster } from "./use-projects";

/** "Working copies" (CM8): who has the project checked out, since when, from which commit. */
export function ProjectWorkingCopies({ project }: { readonly project: Project }) {
  const api = useCommitsApi();
  const roster = useRoster();
  const { state } = useResource(() => api.workingCopies(project.id));
  return (
    <Section
      title="Working copies"
      level={3}
      description="People who have checked this project out to edit it. Their changes count only once committed."
    >
      <ResourceView state={state} label="working copies">
        {(copies) =>
          copies.length === 0 ? (
            <EmptyState title="Nobody has this project checked out." />
          ) : (
            <Table caption="Working copies" hideCaption>
              <TableHead>
                <TableRow>
                  <TableHeader>Person</TableHeader>
                  <TableHeader>Since</TableHeader>
                  <TableHeader>Based on</TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {copies.map((c) => (
                  <TableRow key={c.userId}>
                    <TableRowHeader>{roster.nameOf(c.userId)}</TableRowHeader>
                    <TableCell>
                      <DateTime value={c.createdAt} />
                    </TableCell>
                    <TableCell>
                      {c.baseCommitSeq === null ? "no commit yet" : `#${c.baseCommitSeq}`}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )
        }
      </ResourceView>
    </Section>
  );
}
