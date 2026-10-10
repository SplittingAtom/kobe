"use client";

import Link from "next/link";
import { useState } from "react";
import { projectPermissions } from "@kobe/protocol";
import { worded, type ProjectInput } from "../../lib/projects/api";
import { useTeamAccess } from "../admin/console-context";
import { MutationStatus } from "../admin/error-notice";
import { DateTime, ResourceView } from "../admin/parts";
import { useMutation, useResource } from "../admin/use-resource";
import styles from "../admin/admin.module.css";
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
      <h1>Projects</h1>
      <p className={styles.hint}>
        A project gathers instructions, files, memory and shared conversations for the people
        working on something together.
      </p>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <p className={styles.actions}>
        {canCreate && !creating && (
          <button type="button" onClick={() => setCreating(true)}>
            New project
          </button>
        )}
        <label>
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />{" "}
          Show archived projects
        </label>
      </p>
      {creating && (
        <section aria-label="New project">
          <h2>New project</h2>
          <ProjectForm
            initial={EMPTY_PROJECT}
            agents={agents}
            submitLabel="Create project"
            disabled={false}
            pending={mutation.pending}
            onSubmit={(input) => void create(input)}
          />
          <button type="button" onClick={() => setCreating(false)}>
            Cancel
          </button>
        </section>
      )}
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
          <p>
            No projects yet.
            {canCreate ? " Create one to share instructions and files." : ""}
          </p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption>Projects you can see</caption>
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  <th scope="col">Your role</th>
                  <th scope="col">People</th>
                  <th scope="col">Files</th>
                  <th scope="col">Updated</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id}>
                    <th scope="row">
                      <Link href={`/me/projects/${p.id}`}>{p.name}</Link>
                      {p.archivedAt !== null && " (archived)"}
                      {p.description && <div className={styles.hint}>{p.description}</div>}
                    </th>
                    <td>{p.myRole ?? "Team admin"}</td>
                    <td>{MODE_LABEL[p.membersMode]}</td>
                    <td>{p.fileCount}</td>
                    <td>
                      <DateTime value={p.updatedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
    </ResourceView>
  );
}
