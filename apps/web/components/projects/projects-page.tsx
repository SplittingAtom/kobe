"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { projectPermissions } from "@kobe/protocol";
import { worded, type ProjectInput } from "../../lib/projects/api";
import { useTeamAccess } from "../admin/console-context";
import { MutationStatus } from "../admin/error-notice";
import { DateTime, ResourceView } from "../admin/parts";
import { useResource } from "../admin/use-resource";
import { useProjectMutation } from "./use-project-mutation";
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
import { EMPTY_PROJECT, PROJECT_AUDIENCE_HINT, ProjectForm } from "./project-form";
import { useProjectAgents, useProjectsApi } from "./use-projects";

/** Projects of the active team (`/v1/projects`, KOBE-161): the ones you can see, and create. */
export function ProjectsPage() {
  const access = useTeamAccess();
  const api = useProjectsApi();
  const agents = useProjectAgents(api);
  const [archived, setArchived] = useState(false);
  const [listKey, setListKey] = useState(0);
  const mutation = useProjectMutation();
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
          <p className="m-0 text-sm text-console-muted">{PROJECT_AUDIENCE_HINT}</p>
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
      <ProjectList
        key={`${archived}:${listKey}`}
        archived={archived}
        canCreate={canCreate}
        teamAdmin={access.role === "team_admin"}
      />
    </>
  );
}

function ProjectList({
  archived,
  canCreate,
  teamAdmin,
}: {
  readonly archived: boolean;
  readonly canCreate: boolean;
  /** Team admins see the projects that lost their last owner (PR5, "No owner: assign one"). */
  readonly teamAdmin: boolean;
}) {
  const api = useProjectsApi();
  const { state } = useResource(() => api.list(archived));
  const ownerless = useOwnerless(teamAdmin);
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
                    {ownerless.has(p.id) && (
                      <div className="text-sm font-normal">
                        <Link href={`/me/projects/${p.id}#project-owner`}>
                          No owner: assign one
                        </Link>
                      </div>
                    )}
                    {p.description && (
                      <div className="text-sm font-normal text-console-muted">{p.description}</div>
                    )}
                  </TableRowHeader>
                  <TableCell>{p.myRole ?? "Team admin"}</TableCell>
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

/** Ids of the projects without an owner (team admins only; nothing when it cannot be read). */
function useOwnerless(teamAdmin: boolean): ReadonlySet<string> {
  const api = useProjectsApi();
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!teamAdmin) return;
    let current = true;
    void api.noOwner().then((res) => {
      if (current && res.ok) setIds(new Set(res.data.map((p) => p.id)));
    });
    return () => {
      current = false;
    };
  }, [api, teamAdmin]);
  return ids;
}
