import { useState } from "react";
import {
  listTeamAgentVersions,
  type AgentVersionSummary,
} from "../../../../lib/admin/api/team/agent-builder";
import { DateTime, ResourceView } from "../../parts";
import { useMutation, useResource } from "../../use-resource";
import { ErrorNotice } from "../../error-notice";
import { OrbitExportButton } from "./orbit-export-button";
import styles from "../../admin.module.css";

/** Published versions, newest first; restoring one republishes it as the newest (D19). */
export function VersionHistory({
  teamId,
  agentId,
  agentSlug,
  currentVersion,
  canExport,
  canRestore,
  restoring,
  onRestore,
}: {
  readonly teamId: string;
  readonly agentId: string;
  readonly agentSlug: string;
  readonly currentVersion: number | null;
  readonly canExport: boolean;
  readonly canRestore: boolean;
  readonly restoring: boolean;
  readonly onRestore: (version: number) => void;
}) {
  const { state } = useResource(() => listTeamAgentVersions(teamId, agentId));
  const more = useMutation();
  const [older, setOlder] = useState<readonly AgentVersionSummary[]>([]);
  const [cursor, setCursor] = useState<number | null | undefined>(undefined);

  return (
    <section aria-labelledby="history-title">
      <h2 id="history-title">Version history</h2>
      <ResourceView state={state} label="versions">
        {(page) => {
          const versions = [...page.versions, ...older];
          const nextBefore = cursor === undefined ? page.nextBefore : cursor;
          if (versions.length === 0) return <p>Nothing is published yet.</p>;
          return (
            <>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <caption className={styles.visuallyHidden}>Published versions</caption>
                  <thead>
                    <tr>
                      <th scope="col">Version</th>
                      <th scope="col">Published</th>
                      <th scope="col">
                        <span className={styles.visuallyHidden}>Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {versions.map((v) => (
                      <tr key={v.version}>
                        <th scope="row">
                          v{v.version}
                          {v.version === currentVersion && (
                            <>
                              {" "}
                              <span>Current</span>
                            </>
                          )}
                          {v.republishedFrom !== null && (
                            <div className={styles.hint}>Restored from v{v.republishedFrom}</div>
                          )}
                        </th>
                        <td>
                          <DateTime value={v.publishedAt} />
                        </td>
                        <td>
                          {canExport && (
                            <OrbitExportButton
                              teamId={teamId}
                              agentId={agentId}
                              agentSlug={agentSlug}
                              version={v.version}
                              label={`Export version ${v.version} to Orbit`}
                            />
                          )}{" "}
                          {canRestore && v.version !== currentVersion && (
                            <button
                              type="button"
                              disabled={restoring}
                              onClick={() => onRestore(v.version)}
                            >
                              {`Restore version ${v.version}`}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {more.error && <ErrorNotice error={more.error} />}
              {nextBefore !== null && (
                <button
                  type="button"
                  disabled={more.pending}
                  onClick={() =>
                    void more.run(async () => {
                      const res = await listTeamAgentVersions(teamId, agentId, nextBefore);
                      if (res.ok) {
                        setOlder((prev) => [...prev, ...res.data.versions]);
                        setCursor(res.data.nextBefore);
                      }
                      return res;
                    })
                  }
                >
                  Load older versions
                </button>
              )}
            </>
          );
        }}
      </ResourceView>
    </section>
  );
}
