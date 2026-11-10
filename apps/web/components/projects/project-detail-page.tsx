"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { projectPermissions } from "@kobe/protocol";
import { saveBytes } from "../../lib/files/save";
import { worded, type Project, type ProjectInput } from "../../lib/projects/api";
import { useTeamAccess } from "../admin/console-context";
import { MutationStatus } from "../admin/error-notice";
import { ResourceView } from "../admin/parts";
import { useResource } from "../admin/use-resource";
import { useProjectMutation } from "./use-project-mutation";
import {
  Badge,
  Button,
  Notice,
  PageHeader,
  Section,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  eventTrigger,
  useConfirm,
} from "../ui/console";
import { inputOf, ProjectForm } from "./project-form";
import { ProjectFiles } from "./project-files";
import { ProjectHistory } from "./project-history";
import { ProjectMembers } from "./project-members";
import { ProjectStorage } from "./project-storage";
import { ProjectThreads } from "./project-threads";
import { ProjectWorkingCopies } from "./project-working-copies";
import { useCommitsApi, useProjectAgents, useProjectsApi } from "./use-projects";
import { useNavigate } from "../shell/use-navigate";

/**
 * One project (`/v1/projects/:id`, KOBE-161/162/163; Workspaces KOBE-581): Overview (settings,
 * visibility and people, files, storage, conversations) and History (commits, diffs, downloads
 * at a commit, Revert; working copies for owners and admins). "Open to mount" while the project
 * is not in the member's files (no conversation of theirs in it, no checkout; MT1, FP2).
 */
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
  const mutation = useProjectMutation();
  const navigate = useNavigate();
  const [confirm, confirmDialog] = useConfirm();
  const can = projectPermissions(access.role, project.myRole ?? undefined);
  const commits = useCommitsApi();
  const threads = useResource(() => api.threads(project.id));
  const checkout = useResource(() => commits.checkoutState(project.id));
  const me = access.user.id;
  const mounted =
    (threads.state.status === "ready" &&
      threads.state.data.threads.some((t) => t.ownerUserId === me)) ||
    (checkout.state.status === "ready" && checkout.state.data !== null);
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

  async function downloadZip() {
    await mutation.run(
      () => api.downloadHead(project.id),
      (bytes) => {
        saveBytes(`${project.slug}.zip`, bytes);
        return `Downloaded ${project.slug}.zip.`;
      },
    );
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
          <>
            {can.converse && !archived && (
              <Button asChild variant="primary">
                <Link href={`/?project=${project.id}`} aria-describedby="project-mount-hint">
                  {mounted ? "Open in a conversation" : "Open to mount"}
                </Link>
              </Button>
            )}
            <Button disabled={mutation.pending} onClick={() => void downloadZip()}>
              Download as zip
            </Button>
            {can.view && (
              <Button asChild>
                <Link href={`/me/memory?project=${project.id}`}>Project memory</Link>
              </Button>
            )}
          </>
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
      {can.converse && !archived && (
        <p id="project-mount-hint" className="m-0 mb-2 text-sm text-console-muted">
          {mounted
            ? `In your files under projects/${project.slug}.`
            : `Not in your files yet: open it in a conversation and it appears under projects/${project.slug}.`}
        </p>
      )}
      {!can.edit && (
        <p className="m-0 mb-2 text-sm">
          <Badge>reader</Badge> You can read this project and start conversations in it, not change
          its files.
        </p>
      )}
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <Tabs defaultValue="overview" className="mt-2">
        <TabsList label="Project">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
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
          <ProjectFiles project={project} canManage={can.edit} />
          <ProjectStorage project={project} />
          <ProjectThreads project={project} state={threads.state} />
        </TabsContent>
        <TabsContent value="history">
          <ProjectHistory project={project} canRevert={can.edit} />
          {can.manage && <ProjectWorkingCopies project={project} />}
        </TabsContent>
      </Tabs>
      {confirmDialog}
    </>
  );
}
