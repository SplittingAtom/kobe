"use client";

import Link from "next/link";
import { projectPermissions } from "@kobe/protocol";
import { worded, type Project, type ProjectInput } from "../../lib/projects/api";
import { useTeamAccess } from "../admin/console-context";
import { MutationStatus } from "../admin/error-notice";
import { ResourceView, confirmed } from "../admin/parts";
import { useMutation, useResource } from "../admin/use-resource";
import styles from "../admin/admin.module.css";
import { inputOf, ProjectForm } from "./project-form";
import { ProjectFiles } from "./project-files";
import { ProjectMembers } from "./project-members";
import { ProjectThreads } from "./project-threads";
import { useProjectAgents, useProjectsApi } from "./use-projects";

/** One project: settings, members, files and conversations (`/v1/projects/:id`, KOBE-161/162/163). */
export function ProjectDetailPage({ projectId }: { readonly projectId: string }) {
  const api = useProjectsApi();
  const { state, reload } = useResource(() => api.get(projectId));
  return (
    <>
      <p>
        <Link href="/me/projects">All projects</Link>
      </p>
      <ResourceView state={state} label="the project">
        {(project) => <ProjectView project={project} onChanged={reload} />}
      </ResourceView>
    </>
  );
}

function ProjectView({
  project,
  onChanged,
}: {
  readonly project: Project;
  readonly onChanged: () => void;
}) {
  const access = useTeamAccess();
  const api = useProjectsApi();
  const agents = useProjectAgents(api);
  const mutation = useMutation();
  const can = projectPermissions(access.role, project.myRole ?? undefined);
  const archived = project.archivedAt !== null;
  const canEdit = can.manage && !archived;

  async function save(input: ProjectInput) {
    if (
      await mutation.run(
        async () => worded(await api.update(project.id, input)),
        () => "Saved.",
      )
    ) {
      onChanged();
    }
  }

  async function archive(value: boolean) {
    if (
      value &&
      !confirmed(
        `Archive ${project.name}? It becomes read-only; shared conversations stay readable.`,
      )
    ) {
      return;
    }
    const done = await mutation.run(
      async () => worded(await api.update(project.id, { archived: value })),
      () => (value ? "Archived." : "Restored."),
    );
    if (done) onChanged();
  }

  async function remove() {
    if (!confirmed(`Delete ${project.name} for good? Archive it instead to keep its history.`)) {
      return;
    }
    const done = await mutation.run(
      async () => worded(await api.remove(project.id)),
      () => "Deleted.",
    );
    if (done) window.location.assign("/me/projects");
  }

  return (
    <>
      <h1>
        {project.name}
        {archived && " (archived)"}
      </h1>
      {archived && (
        <p role="note" className={styles.hint}>
          This project is archived and read-only. Its files and shared conversations stay readable.
        </p>
      )}
      <p className={styles.actions}>
        {can.use && !archived && (
          <Link href={`/?project=${project.id}`}>New conversation in this project</Link>
        )}
        {project.myRole !== null && (
          <Link href={`/me/memory?project=${project.id}`}>Project memory</Link>
        )}
      </p>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <section aria-label="Settings">
        <h2>Settings</h2>
        {!can.manage && (
          <p className={styles.hint}>
            Only the project&apos;s owners and team admins can change these.
          </p>
        )}
        <ProjectForm
          key={project.updatedAt}
          initial={inputOf(project)}
          agents={agents}
          submitLabel="Save changes"
          disabled={!canEdit}
          pending={mutation.pending}
          onSubmit={(input) => void save(input)}
        />
        {can.manage && (
          <p className={styles.actions}>
            <button
              type="button"
              disabled={mutation.pending}
              onClick={() => void archive(!archived)}
            >
              {archived ? "Restore project" : "Archive project"}
            </button>
            <button type="button" disabled={mutation.pending} onClick={() => void remove()}>
              Delete project
            </button>
          </p>
        )}
      </section>
      <ProjectMembers project={project} canManage={can.manage_members} />
      <ProjectFiles project={project} canManage={can.manage} />
      <ProjectThreads project={project} />
    </>
  );
}
