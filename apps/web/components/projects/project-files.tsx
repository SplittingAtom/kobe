"use client";

import { useRef, useState, type FormEvent } from "react";
import { worded, type Project, type ProjectFile } from "../../lib/projects/api";
import { MutationStatus } from "../admin/error-notice";
import { DateTime, ResourceView } from "../admin/parts";
import { useFocusAfterRemoval } from "../admin/use-focus-after-removal";
import { useMutation, useResource } from "../admin/use-resource";
import {
  Button,
  EmptyState,
  Field,
  FormRow,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
  TextInput,
  eventTrigger,
  useConfirm,
} from "../ui/console";

/** The list's heading: focus lands here when a delete empties the list. */
const HEADING = "project-files";
import { useProjectsApi, useRoster } from "./use-projects";

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Files of one project: members read them (mounted read-only in sandboxes), managers change them. */
export function ProjectFiles({
  project,
  canManage,
}: {
  readonly project: Project;
  readonly canManage: boolean;
}) {
  const api = useProjectsApi();
  const { state, reload } = useResource(() => api.files(project.id));
  const roster = useRoster();
  const mutation = useMutation();
  const editable = canManage && project.archivedAt === null;
  const picker = useRef<HTMLInputElement>(null);
  const [folder, setFolder] = useState("");
  const [confirm, confirmDialog] = useConfirm();
  const focus = useFocusAfterRemoval(
    state.status === "ready" ? state.data.map((f) => f.id) : null,
    HEADING,
  );

  async function upload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const file = picker.current?.files?.[0];
    if (!file) return;
    const done = await mutation.run(
      async () => worded(await api.uploadFile(project.id, file, folder.trim())),
      () => `Added ${file.name}.`,
    );
    if (done) {
      if (picker.current) picker.current.value = "";
      reload();
    }
  }

  async function remove(file: ProjectFile, index: number, trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Delete ${file.path} from this project?`,
        description: "Members lose it at their next sync.",
        confirmLabel: "Delete file",
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      async () => worded(await api.removeFile(project.id, file.id)),
      () => `Deleted ${file.path}.`,
    );
    if (done) {
      focus.removed(file.id, index);
      reload();
    }
  }

  return (
    <Section
      id={HEADING}
      title="Files"
      description={`Members see these files read-only in their workspace under projects/${project.slug}. An agent can propose a file from a conversation, but it is added only after the person in that conversation approves it; approved proposals are marked below.`}
    >
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="files">
        {(files) =>
          files.length === 0 ? (
            <EmptyState title="No files yet." />
          ) : (
            <div ref={focus.container}>
              <Table caption="Project files" hideCaption>
                <TableHead>
                  <TableRow>
                    <TableHeader>File</TableHeader>
                    <TableHeader numeric>Size</TableHeader>
                    <TableHeader>Added by</TableHeader>
                    <TableHeader>Added</TableHeader>
                    <TableHeader>
                      <span className="sr-only">Actions</span>
                    </TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {files.map((f, index) => (
                    <TableRow key={f.id}>
                      <TableRowHeader className="break-all">
                        {f.path}
                        {f.source === "proposal" && (
                          <div className="text-sm font-normal text-console-muted">
                            Proposed by an agent, approved
                          </div>
                        )}
                      </TableRowHeader>
                      <TableCell numeric>{size(f.sizeBytes)}</TableCell>
                      <TableCell>{roster.nameOf(f.addedBy)}</TableCell>
                      <TableCell>
                        <DateTime value={f.addedAt} />
                      </TableCell>
                      <TableCell>
                        {editable && (
                          <Button
                            size="sm"
                            variant="danger"
                            data-remove=""
                            disabled={mutation.pending}
                            onClick={(e) => void remove(f, index, eventTrigger(e))}
                          >
                            Delete<span className="sr-only"> {f.path}</span>
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )
        }
      </ResourceView>
      {editable && (
        <form aria-label="Add a file" onSubmit={(e) => void upload(e)}>
          <FormRow>
            <Field label="File">
              <TextInput ref={picker} type="file" required className="py-0.5" />
            </Field>
            <Field label="Folder (optional)">
              <TextInput
                value={folder}
                maxLength={200}
                onChange={(e) => setFolder(e.target.value)}
              />
            </Field>
            <Button type="submit" variant="primary" disabled={mutation.pending}>
              Upload file
            </Button>
          </FormRow>
        </form>
      )}
      {confirmDialog}
    </Section>
  );
}
