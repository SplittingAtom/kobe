"use client";

import { useRef, useState, type FormEvent } from "react";
import { worded, type Project, type ProjectFile } from "../../lib/projects/api";
import { MutationStatus } from "../admin/error-notice";
import { DateTime, ResourceView, confirmed } from "../admin/parts";
import { useMutation, useResource } from "../admin/use-resource";
import styles from "../admin/admin.module.css";
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

  async function remove(file: ProjectFile) {
    if (!confirmed(`Delete ${file.path} from this project? Members lose it at their next sync.`)) {
      return;
    }
    const done = await mutation.run(
      async () => worded(await api.removeFile(project.id, file.id)),
      () => `Deleted ${file.path}.`,
    );
    if (done) reload();
  }

  return (
    <section aria-label="Files">
      <h2>Files</h2>
      <p className={styles.hint}>
        Members see these files read-only in their workspace under projects/{project.slug}. An agent
        can propose a file from a conversation, but it is added only after the person in that
        conversation approves it; approved proposals are marked below.
      </p>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="files">
        {(files) =>
          files.length === 0 ? (
            <p>No files yet.</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption>Project files</caption>
                <thead>
                  <tr>
                    <th scope="col">File</th>
                    <th scope="col">Size</th>
                    <th scope="col">Added by</th>
                    <th scope="col">Added</th>
                    <th scope="col">
                      <span className={styles.visuallyHidden}>Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {files.map((f) => (
                    <tr key={f.id}>
                      <th scope="row">
                        {f.path}
                        {f.source === "proposal" && (
                          <div className={styles.hint}>Proposed by an agent, approved</div>
                        )}
                      </th>
                      <td>{size(f.sizeBytes)}</td>
                      <td>{roster.nameOf(f.addedBy)}</td>
                      <td>
                        <DateTime value={f.addedAt} />
                      </td>
                      <td>
                        {editable && (
                          <button
                            type="button"
                            disabled={mutation.pending}
                            onClick={() => void remove(f)}
                          >
                            Delete<span className={styles.visuallyHidden}> {f.path}</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </ResourceView>
      {editable && (
        <form className={styles.form} aria-label="Add a file" onSubmit={(e) => void upload(e)}>
          <label>
            File
            <input ref={picker} type="file" required />
          </label>
          <label>
            Folder (optional)
            <input value={folder} maxLength={200} onChange={(e) => setFolder(e.target.value)} />
          </label>
          <button type="submit" disabled={mutation.pending}>
            Upload file
          </button>
        </form>
      )}
    </section>
  );
}
