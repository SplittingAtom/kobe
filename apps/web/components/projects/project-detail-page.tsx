"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { projectPermissions } from "@kobe/protocol";
import { worded, type Project, type ProjectInput } from "../../lib/projects/api";
import { useTeamAccess } from "../admin/console-context";
import { MutationStatus } from "../admin/error-notice";
import { ResourceView } from "../admin/parts";
import { useMutation, useResource } from "../admin/use-resource";
import { Button, Notice, PageHeader, Section, eventTrigger, useConfirm } from "../ui/console";
import { inputOf, ProjectForm } from "./project-form";
import { ProjectFiles } from "./project-files";
import { ProjectMembers } from "./project-members";
import { ProjectThreads } from "./project-threads";
import { useProjectAgents, useProjectsApi } from "./use-projects";
import { useNavigate } from "../shell/use-navigate";

/** One project: settings, members, files and conversations (`/v1/projects/:id`, KOBE-161/162/163). */
export function ProjectDetailPage({ projectId }: { readonly projectId: string }) {
  const api = useProjectsApi();
  const { state, reload } = useResource(() => api.get(projectId));
  const back = <Link href="/me/projects">All projects</Link>;
  return (
    <ResourceView state={state} label="the project">
      {(project) => <ProjectView project={project} back={back} onChanged={reload} />}
    </ResourceView>
  );
}

function ProjectView({
  project,
  back,
  onChanged,
}: {
  readonly project: Project;
  readonly back: ReactNode;
  readonly onChanged: () => void;
}) {
  const access = useTeamAccess();
  const api = useProjectsApi();
  const agents = useProjectAgents(api);
  const mutation = useMutation();
  const navigate = useNavigate();
  const [confirm, confirmDialog] = useConfirm();
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

  async function archive(value: boolean, trigger: HTMLElement | null) {
    if (
      value &&
      !(await confirm(
        {
          title: `Archive ${project.name}?`,
          description: "It becomes read-only; shared conversations stay readable.",
          confirmLabel: "Archive project",
        },
        trigger,
      ))
    ) {
      return;
    }
    const done = await mutation.run(
      async () => worded(await api.update(project.id, { archived: value })),
      () => (value ? "Archived." : "Restored."),
    );
    if (done) onChanged();
  }

  async function remove(trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Delete ${project.name} for good?`,
        description: "Archive it instead to keep its history.",
        confirmLabel: "Delete project",
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      async () => worded(await api.remove(project.id)),
      () => "Deleted.",
    );
    if (done) navigate("/me/projects");
  }

  return (
    <>
      <PageHeader
        back={back}
        title={
          <>
            {project.name}
            {archived && " (archived)"}
          </>
        }
        actions={
          (can.use && !archived) || project.myRole !== null ? (
            <>
              {can.use && !archived && (
                <Button asChild variant="primary">
                  <Link href={`/?project=${project.id}`}>New conversation in this project</Link>
                </Button>
              )}
              {project.myRole !== null && (
                <Button asChild>
                  <Link href={`/me/memory?project=${project.id}`}>Project memory</Link>
                </Button>
              )}
            </>
          ) : undefined
        }
      />
      {archived && (
        <Notice tone="warn" role="note">
          <p>
            This project is archived and read-only. Its files and shared conversations stay
            readable.
          </p>
        </Notice>
      )}
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <Section title="Settings">
        {!can.manage && (
          <p className="m-0 text-sm text-console-muted">
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
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={mutation.pending}
              onClick={(e) => void archive(!archived, eventTrigger(e))}
            >
              {archived ? "Restore project" : "Archive project"}
            </Button>
            <Button
              variant="danger"
              disabled={mutation.pending}
              onClick={(e) => void remove(eventTrigger(e))}
            >
              Delete project
            </Button>
          </div>
        )}
      </Section>
      <ProjectMembers project={project} canManage={can.manage_members} />
      <ProjectFiles project={project} canManage={can.manage} />
      <ProjectThreads project={project} />
      {confirmDialog}
    </>
  );
}
