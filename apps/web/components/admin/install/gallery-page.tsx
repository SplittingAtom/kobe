"use client";

import { useRef, type FormEvent } from "react";
import {
  deleteGalleryAgent,
  galleryExportHref,
  importGalleryAgent,
  listGalleryAgents,
  setGalleryAgentStatus,
  type AgentSaved,
  type AgentSummary,
} from "../../../lib/admin/api/install";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView, confirmed } from "../parts";
import { useMutation, useResource } from "../use-resource";
import styles from "../admin.module.css";

/** Agent files are ≤ 128 KiB (KOBE-45); refuse bigger ones before uploading. */
const MAX_AGENT_FILE_BYTES = 128 * 1024;

function savedNotice(saved: AgentSaved): string {
  const warnings = saved.warnings?.length ?? 0;
  return warnings > 0
    ? `Imported ${saved.agent.name} with ${warnings} warning${warnings === 1 ? "" : "s"}: review its tools and approval mode.`
    : `Imported ${saved.agent.name}.`;
}

/** Gallery agents (spec D19/D21; `/v1/install/gallery/agents`): install-wide, read-only to teams. */
export function GalleryPage() {
  const { state, reload } = useResource(listGalleryAgents);
  const mutation = useMutation();
  const fileInput = useRef<HTMLInputElement>(null);

  async function onImport(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const file = fileInput.current?.files?.[0];
    if (!file) return;
    if (file.size > MAX_AGENT_FILE_BYTES) {
      await mutation.run(async () => ({
        ok: false,
        error: { status: 413, code: "too_large", message: "Agent files can be at most 128 KiB." },
      }));
      return;
    }
    const done = await mutation.run(async () => importGalleryAgent(await file.text()), savedNotice);
    if (done) {
      if (fileInput.current) fileInput.current.value = "";
      reload();
    }
  }

  async function toggle(agent: AgentSummary) {
    const next = agent.status === "active" ? "suspended" : "active";
    if (
      next === "suspended" &&
      !confirmed(`Suspend ${agent.name}? No team can start new conversations with it.`)
    ) {
      return;
    }
    const done = await mutation.run(
      () => setGalleryAgentStatus(agent.id, next),
      () => `${agent.name} is ${next}.`,
    );
    if (done) reload();
  }

  async function remove(agent: AgentSummary) {
    if (!confirmed(`Delete ${agent.name} from the gallery? Teams' forks are kept.`)) return;
    const done = await mutation.run(
      () => deleteGalleryAgent(agent.id),
      () => `Deleted ${agent.name}.`,
    );
    if (done) reload();
  }

  return (
    <>
      <h1>Gallery agents</h1>
      <p className={styles.hint}>
        Gallery agents are available to every team, read-only; teams fork them to change them. The
        agent builder arrives with KOBE-48; until then, import agent files here.
      </p>
      <form onSubmit={onImport} className={styles.form} aria-label="Import an agent">
        <label>
          Agent file (.md)
          <input ref={fileInput} type="file" accept=".md,text/markdown" required />
        </label>
        <button type="submit" disabled={mutation.pending}>
          Import
        </button>
      </form>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="gallery agents">
        {(agents) =>
          agents.length === 0 ? (
            <p>The gallery is empty.</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption>Gallery</caption>
                <thead>
                  <tr>
                    <th scope="col">Agent</th>
                    <th scope="col">Slug</th>
                    <th scope="col">Status</th>
                    <th scope="col">Version</th>
                    <th scope="col">Updated</th>
                    <th scope="col">
                      <span className={styles.visuallyHidden}>Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {agents.map((a) => (
                    <tr key={a.id}>
                      <th scope="row">
                        {a.name}
                        {a.description && <div className={styles.hint}>{a.description}</div>}
                      </th>
                      <td>
                        <code>{a.slug}</code>
                      </td>
                      <td>{a.status === "active" ? "Active" : "Suspended"}</td>
                      <td>{a.currentVersion === null ? "Draft" : `v${a.currentVersion}`}</td>
                      <td>
                        <DateTime value={a.updatedAt} />
                      </td>
                      <td>
                        <div className={styles.actions}>
                          <a href={galleryExportHref(a.id)} download={`${a.slug}.md`}>
                            Export<span className={styles.visuallyHidden}> {a.name}</span>
                          </a>
                          <button
                            type="button"
                            disabled={mutation.pending}
                            onClick={() => void toggle(a)}
                          >
                            {a.status === "active" ? "Suspend" : "Reactivate"}
                            <span className={styles.visuallyHidden}> {a.name}</span>
                          </button>
                          <button
                            type="button"
                            disabled={mutation.pending}
                            onClick={() => void remove(a)}
                          >
                            Delete<span className={styles.visuallyHidden}> {a.name}</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </ResourceView>
    </>
  );
}
