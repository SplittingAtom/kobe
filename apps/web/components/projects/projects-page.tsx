"use client";

import Link from "next/link";
import { useState } from "react";
import { projectPermissions } from "@kobe/protocol";
import { worded, type ProjectInput } from "../../lib/projects/api";
import { useTeamAccess } from "../admin/console-context";
import { MutationStatus } from "../admin/error-notice";
import { DateTime, ResourceView } from "../admin/parts";
import { useMutation, useResource } from "../admin/use-resource";
import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "../ui/console";
import { EMPTY_PROJECT, ProjectForm } from "./project-form";
import { useProjectAgents, useProjectsApi } from "./use-projects";

const MODE_LABEL = { team: "Whole team", selected: "Selected people" } as const;

/** Projects of the active team (`/v1/projects`, KOBE-161): the ones you can see, and create. */
export function ProjectsPage() {
  const access = useTeamAccess();
  const api = useProjectsApi();
  const agents = useProjectAgents(api);
  const [archived, setArchived] = useState(false);
  const [listKey, setListKey] = useState(0);
  const mutation = useMutation();
  const canCreate = projectPermissions(access.role, undefined).create;
  const [creating, setCreating] = useState(false);

  async function create(input: ProjectInput) {
    const done = await mutation.run(
      async () => worded(await api.create(input)),
      (p) => `Created ${p.name}.`,
    );
    if (done) {
      setCreating(false);
      setListKey((n) => n + 1);
    }
  }

  return (
    <>
      <PageHeader
        title="Projects"
        description="A project gathers instructions, files, memory and shared conversations for the people working on something together."
        actions={
          canCreate &&
          !creating && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              New project
            </Button>
          )
        }
      />
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      {creating && (
        <Card role="region" aria-label="New project" title="New project" level={2} className="my-4">
          <ProjectForm
            initial={EMPTY_PROJECT}
            agents={agents}
            submitLabel="Create project"
            disabled={false}
            pending={mutation.pending}
            onSubmit={(input) => void create(input)}
          />
          <Button onClick={() => setCreating(false)}>Cancel</Button>
        </Card>
      )}
      <Checkbox
        className="my-3"
        label="Show archived projects"
        checked={archived}
        onChange={(e) => setArchived(e.target.checked)}
      />
      <ProjectList key={`${archived}:${listKey}`} archived={archived} canCreate={canCreate} />
    </>
  );
}

function ProjectList({
  archived,
  canCreate,
}: {
  readonly archived: boolean;
  readonly canCreate: boolean;
}) {
  const api = useProjectsApi();
  const { state } = useResource(() => api.list(archived));
  return (
    <ResourceView state={state} label="projects">
      {(projects) =>
        projects.length === 0 ? (
          <EmptyState title="No projects yet.">
            {canCreate ? "Create one to share instructions and files." : null}
          </EmptyState>
        ) : (
          <Table caption="Projects you can see">
            <TableHead>
              <TableRow>
                <TableHeader>Project</TableHeader>
                <TableHeader>Your role</TableHeader>
                <TableHeader>People</TableHeader>
                <TableHeader numeric>Files</TableHeader>
                <TableHeader>Updated</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {projects.map((p) => (
                <TableRow key={p.id}>
                  <TableRowHeader>
                    <Link href={`/me/projects/${p.id}`}>{p.name}</Link>
                    {p.archivedAt !== null && " (archived)"}
                    {p.description && (
                      <div className="text-sm font-normal text-console-muted">{p.description}</div>
                    )}
                  </TableRowHeader>
                  <TableCell>{p.myRole ?? "Team admin"}</TableCell>
                  <TableCell>{MODE_LABEL[p.membersMode]}</TableCell>
                  <TableCell numeric>{p.fileCount}</TableCell>
                  <TableCell>
                    <DateTime value={p.updatedAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )
      }
    </ResourceView>
  );
}
