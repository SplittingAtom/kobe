"use client";

import { agentStatusLabel } from "../../../lib/admin/api/agents";
import { galleryExportHref, listGalleryAgents } from "../../../lib/admin/api/install/gallery";
import { DateTime, ResourceView } from "../parts";
import { useResource } from "../use-resource";
import styles from "../admin.module.css";

/**
 * Gallery agents (spec D19/D21; `/v1/install/gallery/agents`), read-only: they come from the
 * definitions in the repository, seeded at install and upgrade (KOBE-87). Teams fork them.
 */
export function GalleryPage() {
  const { state } = useResource(listGalleryAgents);
  return (
    <>
      <h1>Gallery agents</h1>
      <p className={styles.hint}>
        Gallery agents are available to every team, read-only; teams fork them to change them. They
        come from the definitions shipped with Kobe and update with each release. A team can suspend
        a gallery agent for itself in its agent inventory.
      </p>
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
                      <td>{agentStatusLabel(a)}</td>
                      <td>{a.currentVersion === null ? "Draft" : `v${a.currentVersion}`}</td>
                      <td>
                        <DateTime value={a.updatedAt} />
                      </td>
                      <td>
                        <a href={galleryExportHref(a.id)} download={`${a.slug}.md`}>
                          Export<span className={styles.visuallyHidden}> {a.name}</span>
                        </a>
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
